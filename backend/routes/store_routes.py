from flask import Blueprint, jsonify, current_app as app, request
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client
from utils.offline_transfer_verification_queue import enqueue_transfer_verification_create
from datetime import datetime, timezone
import hashlib
from helpers.utils import read_json_file, write_json_file
from config.config import STORES_FILE, USER_STORES_FILE, STOREINVENTORY_FILE

store_bp = Blueprint('store', __name__)


def _extract_store_id_from_row(row: dict):
    if not isinstance(row, dict):
        return None
    return row.get("storeId") or row.get("storeid")


def _normalize_user_store_row(row: dict):
    if not isinstance(row, dict):
        return None
    return {
        "userId": row.get("userId") or row.get("userid"),
        "storeId": row.get("storeId") or row.get("storeid"),
        "created_at": row.get("created_at") or row.get("createdat"),
        "updated_at": row.get("updated_at") or row.get("updatedat"),
    }


def _fetch_user_store_rows(supabase, user_id: str):
    """
    Read user-store mappings with compatibility for column variants:
    - userId/storeId (camelCase)
    - userid/storeid (lowercase)
    """
    # Primary expected columns.
    try:
        response = (
            supabase.table("userstores")
            .select("*")
            .eq("userId", user_id)
            .execute()
        )
        if response.data:
            return response.data
    except Exception as e:
        app.logger.warning(f"⚠️ userstores camelCase lookup failed: {e}")

    # Fallback lowercase columns.
    try:
        response = (
            supabase.table("userstores")
            .select("*")
            .eq("userid", user_id)
            .execute()
        )
        if response.data:
            return response.data
    except Exception as e:
        app.logger.warning(f"⚠️ userstores lowercase lookup failed: {e}")

    return []


def _get_current_store_id(supabase, user_id: str):
    rows = _fetch_user_store_rows(supabase, user_id)
    if not rows:
        return None
    return _extract_store_id_from_row(rows[0])


def _local_resolve_store_for_user(user_id: str):
    user_stores = read_json_file(USER_STORES_FILE, [])
    assigned = next(
        (
            _normalize_user_store_row(u)
            for u in user_stores
            if str(u.get("userId") or u.get("userid")) == str(user_id)
        ),
        None,
    )
    stores = read_json_file(STORES_FILE, [])
    if assigned and assigned.get("storeId"):
        store = next((s for s in stores if str(s.get("id")) == str(assigned.get("storeId"))), None)
        if store:
            return store

    # Single-store offline fallback if mapping snapshot is missing.
    inventory_rows = read_json_file(STOREINVENTORY_FILE, [])
    store_ids = {
        str(row.get("storeid") or row.get("storeId"))
        for row in inventory_rows
        if row.get("storeid") or row.get("storeId")
    }
    if len(store_ids) == 1:
        only_store_id = next(iter(store_ids))
        return next((s for s in stores if str(s.get("id")) == only_store_id), None)
    return None


def _derive_transfer_item_state(item: dict) -> str:
    assigned = int(item.get("assigned_qty") or 0)
    verified = int(item.get("verified_qty") or 0)
    damaged = int(item.get("damaged_qty") or 0)
    wrong_store = int(item.get("wrong_store_qty") or 0)
    processed = verified + damaged + wrong_store
    if processed <= 0:
        return "pending"
    if processed >= assigned:
        return "closed_with_issues" if (damaged > 0 or wrong_store > 0) else "completed"
    return "in_progress"


def _normalize_transfer_barcode(value: str) -> str:
    return str(value or "").strip().lstrip("0")


def _chunk_list(values, chunk_size: int = 100):
    if not values:
        return
    for idx in range(0, len(values), chunk_size):
        yield values[idx: idx + chunk_size]


def _get_transfer_item_product_id(item: dict):
    if not isinstance(item, dict):
        return None
    return item.get("product_id") or item.get("productId") or item.get("productid")


def _get_transfer_item_applied_verified_qty(item: dict):
    if not isinstance(item, dict):
        return 0
    return int(
        item.get("applied_verified_qty")
        or item.get("appliedVerifiedQty")
        or item.get("applied_verified")
        or 0
    )


def _update_local_storeinventory(store_id: str, product_id: str, delta_qty: int, now_iso: str):
    if not delta_qty:
        return
    rows = read_json_file(STOREINVENTORY_FILE, [])
    updated = False
    for row in rows:
        row_store_id = row.get("storeid") or row.get("storeId")
        row_product_id = row.get("productid") or row.get("productId")
        if str(row_store_id) == str(store_id) and str(row_product_id) == str(product_id):
            current_qty = int(row.get("quantity") or 0)
            row["quantity"] = max(0, current_qty + int(delta_qty))
            row["updatedat"] = now_iso
            updated = True
            break

    if not updated and delta_qty > 0:
        rows.append(
            {
                "id": f"INV-LOCAL-{datetime.now(timezone.utc).timestamp()}-{product_id}",
                "storeid": store_id,
                "productid": product_id,
                "quantity": int(delta_qty),
                "assignedat": now_iso,
                "updatedat": now_iso,
            }
        )

    write_json_file(STOREINVENTORY_FILE, rows)

@store_bp.route('/stores', methods=['GET'], strict_slashes=False)
@require_auth
def get_stores():
    """Get all stores"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching stores")
        
        supabase = get_supabase_client()
        response = supabase.table('stores').select('*').execute()
        
        stores = response.data if response.data else []
        
        app.logger.info(f"✅ Fetched {len(stores)} stores")
        return jsonify({"stores": stores}), 200  # ✅ Wrapped in object
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching stores: {str(e)}")
        stores = read_json_file(STORES_FILE, [])
        return jsonify({"stores": stores}), 200  # ✅ Wrapped in object


@store_bp.route('/user-stores', methods=['GET'])
@require_auth
def get_user_stores():
    """Get user-store associations for the current user"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"📍 User {current_user_id} fetching their user-stores")
        
        supabase = get_supabase_client()
        
        user_store_rows = _fetch_user_store_rows(supabase, current_user_id)
        user_stores = [
            normalized for normalized in (_normalize_user_store_row(row) for row in user_store_rows) if normalized
        ]
        
        app.logger.info(f"✅ Found {len(user_stores)} user-store associations for user {current_user_id}")
        app.logger.debug(f"User-stores data: {user_stores}")
        
        return jsonify(user_stores), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching user stores: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        user_stores = read_json_file(USER_STORES_FILE, [])
        user_stores = [
            _normalize_user_store_row(u)
            for u in user_stores
            if str(u.get("userId") or u.get("userid")) == str(current_user_id)
        ]
        user_stores = [u for u in user_stores if u]
        return jsonify(user_stores), 200


@store_bp.route('/stores/current', methods=['GET'])
@require_auth
def get_current_user_store():
    """Get the store assigned to the current user (with full store details)"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"📍 User {current_user_id} fetching their assigned store")
        
        supabase = get_supabase_client()
        
        user_store_rows = _fetch_user_store_rows(supabase, current_user_id)
        if not user_store_rows or len(user_store_rows) == 0:
            local_store = _local_resolve_store_for_user(current_user_id) if getattr(supabase, "is_offline_fallback", False) else None
            if local_store:
                app.logger.warning(f"⚠️ No user-store mapping found; using local single-store fallback {local_store.get('id')}")
                return jsonify(local_store), 200
            app.logger.warning(f"⚠️ No store assigned to user {current_user_id}")
            return jsonify({"message": "No store assigned to this user"}), 404

        store_id = _extract_store_id_from_row(user_store_rows[0])
        if not store_id:
            app.logger.warning(f"⚠️ Store mapping row found without store ID for user {current_user_id}")
            return jsonify({"message": "No store assigned to this user"}), 404
        app.logger.info(f"📍 User {current_user_id} is assigned to store {store_id}")
        
        # Get store details
        store_response = supabase.table('stores') \
            .select('*') \
            .eq('id', store_id) \
            .execute()
        
        if not store_response.data or len(store_response.data) == 0:
            app.logger.error(f"❌ Store {store_id} not found in database")
            return jsonify({"message": "Store not found"}), 404
        
        store = store_response.data[0]
        app.logger.info(f"✅ Found store: {store['name']} (ID: {store['id']})")
        
        return jsonify(store), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching current user store: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        store = _local_resolve_store_for_user(current_user_id)
        if not store:
            return jsonify({"message": "No store assigned to this user"}), 404
        return jsonify(store), 200


@store_bp.route('/stores/current/transfer-orders', methods=['GET'])
@require_auth
def get_current_store_transfer_orders():
    """List active transfer orders for the current user's store."""
    try:
        current_user_id = get_jwt_identity()
        supabase = get_supabase_client()
        store_id = _get_current_store_id(supabase, current_user_id)
        if not store_id:
            return jsonify({"message": "No store assigned to this user"}), 404

        status_filter = request.args.get("status")
        query = supabase.table("inventory_transfer_orders").select("*").eq("store_id", store_id)
        if status_filter:
            query = query.eq("status", status_filter)
        else:
            query = query.in_("status", ["pending", "in_progress"])

        order_response = query.order("created_at", desc=True).execute()
        orders = order_response.data or []
        if not orders:
            return jsonify([]), 200

        order_ids = [o.get("id") for o in orders if o.get("id")]
        items_response = supabase.table("inventory_transfer_items").select("*").in_("transfer_order_id", order_ids).execute()
        items = items_response.data or []

        items_by_order = {}
        for item in items:
            items_by_order.setdefault(item.get("transfer_order_id"), []).append(item)

        enriched = []
        for order in orders:
            order_items = items_by_order.get(order.get("id"), [])
            assigned = sum(int(i.get("assigned_qty") or 0) for i in order_items)
            verified = sum(int(i.get("verified_qty") or 0) for i in order_items)
            damaged = sum(int(i.get("damaged_qty") or 0) for i in order_items)
            wrong_store = sum(int(i.get("wrong_store_qty") or 0) for i in order_items)
            missing = max(0, assigned - verified - damaged - wrong_store)
            status = order.get("status")
            if status in ["pending", "in_progress"] and assigned > 0:
                if missing == 0:
                    status = "closed_with_issues" if (damaged > 0 or wrong_store > 0) else "completed"
                elif verified > 0 or damaged > 0 or wrong_store > 0:
                    status = "in_progress"

            enriched.append(
                {
                    **order,
                    "status": status,
                    "assigned_qty_total": assigned,
                    "verified_qty_total": verified,
                    "damaged_qty_total": damaged,
                    "wrong_store_qty_total": wrong_store,
                    "missing_qty_total": missing,
                    "item_count": len(order_items),
                }
            )

        return jsonify(enriched), 200
    except Exception as e:
        app.logger.error(f"❌ Error fetching current store transfer orders: {str(e)}")
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@store_bp.route('/stores/current/transfer-orders/history', methods=['GET'])
@require_auth
def get_transfer_orders_history():
    """List ALL transfer orders for the current user's store with item details and last verified time per item."""
    try:
        current_user_id = get_jwt_identity()
        supabase = get_supabase_client()
        store_id = _get_current_store_id(supabase, current_user_id)
        if not store_id:
            return jsonify({"message": "No store assigned to this user"}), 404

        order_response = (
            supabase.table("inventory_transfer_orders")
            .select("*")
            .eq("store_id", store_id)
            .order("created_at", desc=True)
            .limit(500)
            .execute()
        )
        orders = order_response.data or []
        if not orders:
            return jsonify([]), 200

        order_ids = [o.get("id") for o in orders if o.get("id")]
        items = []
        for order_id_batch in _chunk_list(order_ids, 80):
            items_response = (
                supabase.table("inventory_transfer_items")
                .select("*, products(name, barcode, price, selling_price)")
                .in_("transfer_order_id", order_id_batch)
                .execute()
            )
            items.extend(items_response.data or [])
        item_ids = [it.get("id") for it in items if it.get("id")]

        last_verified_by_item = {}
        if item_ids:
            try:
                for item_id_batch in _chunk_list(item_ids, 80):
                    scans_response = (
                        supabase.table("inventory_transfer_scans")
                        .select("transfer_item_id, event_type, created_at")
                        .in_("transfer_item_id", item_id_batch)
                        .eq("event_type", "verified")
                        .order("created_at", desc=True)
                        .execute()
                    )
                    for scan in scans_response.data or []:
                        tid = scan.get("transfer_item_id")
                        if not tid:
                            continue
                        if tid not in last_verified_by_item:
                            last_verified_by_item[tid] = scan.get("created_at")
            except Exception as scan_err:
                app.logger.warning(f"⚠️ Failed to load scan history: {scan_err}")

        items_by_order = {}
        for item in items:
            product_ref = item.get("products")
            if isinstance(product_ref, list):
                product_ref = product_ref[0] if product_ref else {}
            if not isinstance(product_ref, dict):
                product_ref = {}

            normalized = {
                **item,
                "products": {
                    **product_ref,
                    "price": product_ref.get("price"),
                    "selling_price": product_ref.get("selling_price"),
                },
                "last_verified_at": last_verified_by_item.get(item.get("id")),
                "status": _derive_transfer_item_state(item),
            }
            items_by_order.setdefault(item.get("transfer_order_id"), []).append(normalized)

        history = []
        for order in orders:
            order_items = items_by_order.get(order.get("id"), [])
            assigned = sum(int(i.get("assigned_qty") or 0) for i in order_items)
            verified = sum(int(i.get("verified_qty") or 0) for i in order_items)
            damaged = sum(int(i.get("damaged_qty") or 0) for i in order_items)
            wrong_store = sum(int(i.get("wrong_store_qty") or 0) for i in order_items)
            missing = max(0, assigned - verified - damaged - wrong_store)
            history.append(
                {
                    **order,
                    "items": order_items,
                    "assigned_qty_total": assigned,
                    "verified_qty_total": verified,
                    "damaged_qty_total": damaged,
                    "wrong_store_qty_total": wrong_store,
                    "missing_qty_total": missing,
                }
            )

        return jsonify(history), 200
    except Exception as e:
        app.logger.error(f"❌ Error fetching transfer orders history: {str(e)}")
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@store_bp.route('/transfer-orders/<order_id>', methods=['GET'])
@require_auth
def get_transfer_order(order_id):
    """Get transfer order details for current user store."""
    try:
        current_user_id = get_jwt_identity()
        supabase = get_supabase_client()
        store_id = _get_current_store_id(supabase, current_user_id)
        if not store_id:
            return jsonify({"message": "No store assigned to this user"}), 404

        order_response = supabase.table("inventory_transfer_orders").select("*").eq("id", order_id).limit(1).execute()
        if not order_response.data:
            return jsonify({"message": "Transfer order not found"}), 404
        order = order_response.data[0]
        if order.get("store_id") != store_id:
            return jsonify({"message": "Transfer order not assigned to your store"}), 403

        items_response = supabase.table("inventory_transfer_items").select("*, products(name, barcode, price, selling_price)").eq(
            "transfer_order_id", order_id
        ).execute()
        items = items_response.data or []
        normalized_items = []
        for item in items:
            product_ref = item.get("products")
            if isinstance(product_ref, list):
                product_ref = product_ref[0] if product_ref else {}
            if not isinstance(product_ref, dict):
                product_ref = {}

            assigned = int(item.get("assigned_qty") or 0)
            verified = int(item.get("verified_qty") or 0)
            damaged = int(item.get("damaged_qty") or 0)
            wrong_store = int(item.get("wrong_store_qty") or 0)
            missing = max(0, assigned - verified - damaged - wrong_store)
            normalized_items.append(
                {
                    **item,
                    "products": {
                        **product_ref,
                        "price": product_ref.get("price"),
                        "selling_price": product_ref.get("selling_price"),
                    },
                    "missing_qty": missing,
                    "status": _derive_transfer_item_state(item),
                }
            )

        order["items"] = normalized_items
        return jsonify(order), 200
    except Exception as e:
        app.logger.error(f"❌ Error fetching transfer order {order_id}: {str(e)}")
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@store_bp.route('/stores/current/transfer-orders/barcode-status', methods=['GET'])
@require_auth
def get_transfer_barcode_status():
    """Resolve barcode against current store transfer orders (active + completed)."""
    try:
        barcode = request.args.get("barcode", "")
        requested_order_id = str(request.args.get("order_id") or "").strip()
        normalized_barcode = _normalize_transfer_barcode(barcode)
        if not normalized_barcode:
            return jsonify({"message": "barcode is required"}), 400

        current_user_id = get_jwt_identity()
        supabase = get_supabase_client()
        store_id = _get_current_store_id(supabase, current_user_id)
        if not store_id:
            return jsonify({"message": "No store assigned to this user"}), 404

        order_response = (
            supabase.table("inventory_transfer_orders")
            .select("id, status, created_at")
            .eq("store_id", store_id)
            .in_("status", ["pending", "in_progress", "completed", "closed_with_issues"])
            .order("created_at", desc=True)
            .limit(300)
            .execute()
        )
        orders = order_response.data or []
        if not orders:
            return jsonify({"found": False, "already_verified": False, "reason": "not_found"}), 200

        order_by_id = {str(o.get("id")): (o.get("status") or "") for o in orders if o.get("id")}
        if requested_order_id:
            if requested_order_id not in order_by_id:
                return jsonify(
                    {
                        "found": False,
                        "already_verified": False,
                        "reason": "order_not_found",
                        "order_id": requested_order_id,
                    }
                ), 200
            orders = [o for o in orders if str(o.get("id")) == requested_order_id]
            order_by_id = {requested_order_id: order_by_id.get(requested_order_id, "")}

        order_ids = list(order_by_id.keys())
        if not order_ids:
            return jsonify({"found": False, "already_verified": False, "reason": "not_found"}), 200

        items_response = (
            supabase.table("inventory_transfer_items")
            .select("id, product_id, transfer_order_id, assigned_qty, verified_qty, damaged_qty, wrong_store_qty, products(barcode, name)")
            .in_("transfer_order_id", order_ids)
            .execute()
        )
        items = items_response.data or []

        matched_items = []
        for item in items:
            product_ref = item.get("products")
            if isinstance(product_ref, list):
                product_ref = product_ref[0] if product_ref else {}
            if not isinstance(product_ref, dict):
                product_ref = {}

            raw_barcodes = str(product_ref.get("barcode") or "")
            normalized_codes = [_normalize_transfer_barcode(code) for code in raw_barcodes.split(",")]
            normalized_codes = [code for code in normalized_codes if code]
            if normalized_barcode in normalized_codes:
                matched_items.append(item)

        if not matched_items:
            return jsonify({"found": False, "already_verified": False, "reason": "not_found"}), 200

        pending_items = []
        processed_items = []
        for item in matched_items:
            assigned = int(item.get("assigned_qty") or 0)
            verified = int(item.get("verified_qty") or 0)
            damaged = int(item.get("damaged_qty") or 0)
            wrong_store = int(item.get("wrong_store_qty") or 0)
            processed = verified + damaged + wrong_store
            if assigned > 0 and processed < assigned:
                pending_items.append(item)
            else:
                processed_items.append(item)

        if pending_items:
            first_pending = pending_items[0]
            pending_order_id = str(first_pending.get("transfer_order_id") or "")
            assigned = int(first_pending.get("assigned_qty") or 0)
            verified = int(first_pending.get("verified_qty") or 0)
            damaged = int(first_pending.get("damaged_qty") or 0)
            wrong_store = int(first_pending.get("wrong_store_qty") or 0)
            processed = verified + damaged + wrong_store
            return jsonify(
                {
                    "found": True,
                    "already_verified": False,
                    "reason": "active_or_pending",
                    "order_id": pending_order_id,
                    "order_status": order_by_id.get(pending_order_id, ""),
                    "item_id": first_pending.get("id"),
                    "assigned_qty": assigned,
                    "verified_qty": verified,
                    "damaged_qty": damaged,
                    "wrong_store_qty": wrong_store,
                    "processed_qty": processed,
                    "store_id": store_id,
                    "requested_order_id": requested_order_id or None,
                }
            ), 200

        first_processed = processed_items[0] if processed_items else matched_items[0]
        inventory_missing = False
        product_id = _get_transfer_item_product_id(first_processed)
        if product_id:
            try:
                inv_response = (
                    supabase.table("storeinventory")
                    .select("id")
                    .eq("storeid", store_id)
                    .eq("productid", product_id)
                    .limit(1)
                    .execute()
                )
                inventory_missing = not bool(inv_response.data)
            except Exception as inv_check_err:
                app.logger.warning(
                    f"⚠️ Failed inventory-exists check for product {product_id}: {inv_check_err}"
                )
        return jsonify(
            {
                "found": True,
                "already_verified": True,
                "reason": "already_verified_inventory_missing" if inventory_missing else "already_verified",
                "order_id": first_processed.get("transfer_order_id"),
                "item_id": first_processed.get("id"),
                "inventory_missing": inventory_missing,
                "assigned_qty": int(first_processed.get("assigned_qty") or 0),
                "verified_qty": int(first_processed.get("verified_qty") or 0),
                "damaged_qty": int(first_processed.get("damaged_qty") or 0),
                "wrong_store_qty": int(first_processed.get("wrong_store_qty") or 0),
                "processed_qty": int(first_processed.get("verified_qty") or 0)
                + int(first_processed.get("damaged_qty") or 0)
                + int(first_processed.get("wrong_store_qty") or 0),
                "store_id": store_id,
                "requested_order_id": requested_order_id or None,
            }
        ), 200

    except Exception as e:
        app.logger.error(f"❌ Error resolving transfer barcode status: {str(e)}")
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


def _apply_transfer_order_verification(supabase, current_user_id: str, store_id: str, order_id: str, data: dict):
    session_id = data.get("verification_session_id")
    item_updates = data.get("items", []) or []
    scans = data.get("scans", []) or []
    if not session_id:
        return {"message": "verification_session_id is required"}, 400

    order_response = supabase.table("inventory_transfer_orders").select("*").eq("id", order_id).limit(1).execute()
    if not order_response.data:
        return {"message": "Transfer order not found"}, 404
    order = order_response.data[0]
    if order.get("store_id") != store_id:
        return {"message": "Transfer order not assigned to your store"}, 403
    if order.get("status") in ["completed", "closed_with_issues", "cancelled"]:
        return {"message": "Transfer order already closed"}, 409

    payload_hash = hashlib.sha256(str(data).encode("utf-8")).hexdigest()
    verification_row = {
        "verification_session_id": session_id,
        "order_id": order_id,
        "store_id": store_id,
        "submitted_by": current_user_id,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "status": "pending",
        "payload_hash": payload_hash,
    }
    try:
        supabase.table("inventory_transfer_verifications").insert(verification_row).execute()
    except Exception:
        existing = supabase.table("inventory_transfer_verifications").select("*").eq(
            "verification_session_id", session_id
        ).limit(1).execute()
        if existing.data:
            return {
                "message": "Duplicate verification ignored",
                "status": "duplicate_ignored",
                "verification_session_id": session_id,
            }, 200
        raise

    items_response = supabase.table("inventory_transfer_items").select("*").eq("transfer_order_id", order_id).execute()
    items = items_response.data or []
    if not items:
        return {"message": "No transfer items found"}, 400

    items_by_id = {item.get("id"): item for item in items if item.get("id")}
    items_by_product = {}
    for item in items:
        item_product_id = _get_transfer_item_product_id(item)
        if item_product_id:
            items_by_product[item_product_id] = item
    now_iso = datetime.now(timezone.utc).isoformat()
    updated_items = []
    damaged_event_rows = []
    local_inventory_deltas = {}
    inventory_results = []

    for update in item_updates:
        item_id = update.get("transfer_item_id") or update.get("transferItemId")
        product_id = update.get("product_id") or update.get("productId")
        item = items_by_id.get(item_id) if item_id else None
        if item is None and product_id:
            item = items_by_product.get(product_id)
        if not item:
            continue

        assigned_qty = int(item.get("assigned_qty") or 0)
        old_verified = int(item.get("verified_qty") or 0)
        old_damaged = int(item.get("damaged_qty") or 0)
        old_wrong = int(item.get("wrong_store_qty") or 0)
        old_applied_verified = _get_transfer_item_applied_verified_qty(item)

        new_verified = int(update.get("verified_qty", old_verified) or 0)
        new_damaged = int(update.get("damaged_qty", old_damaged) or 0)
        new_wrong = int(update.get("wrong_store_qty", old_wrong) or 0)
        if new_verified < 0:
            new_verified = 0
        if new_damaged < 0:
            new_damaged = 0
        if new_wrong < 0:
            new_wrong = 0
        total_processed = new_verified + new_damaged + new_wrong
        if total_processed > assigned_qty:
            overflow = total_processed - assigned_qty
            if new_wrong >= overflow:
                new_wrong -= overflow
            elif new_damaged >= overflow - new_wrong:
                new_damaged -= (overflow - new_wrong)
                new_wrong = 0
            else:
                remainder = overflow - new_wrong - new_damaged
                new_wrong = 0
                new_damaged = 0
                new_verified = max(0, new_verified - remainder)

        delta_verified = max(0, new_verified - old_applied_verified)
        inventory_applied = False
        inventory_error_message = None
        if delta_verified > 0:
            item_product_id = _get_transfer_item_product_id(item)
            product_key = str(item_product_id)
            try:
                inv_response = supabase.table("storeinventory").select("*").eq("storeid", store_id).eq(
                    "productid", item_product_id
                ).limit(1).execute()
                if inv_response.data:
                    inv = inv_response.data[0]
                    new_qty = int(inv.get("quantity") or 0) + delta_verified
                    supabase.table("storeinventory").update({"quantity": new_qty, "updatedat": now_iso}).eq(
                        "id", inv.get("id")
                    ).execute()
                else:
                    supabase.table("storeinventory").insert(
                        {
                            "id": f"INV-{datetime.now(timezone.utc).timestamp()}-{item_product_id}",
                            "storeid": store_id,
                            "productid": item_product_id,
                            "quantity": delta_verified,
                            "assignedat": now_iso,
                            "updatedat": now_iso,
                        }
                    ).execute()

                # Confirm the row exists in storeinventory after upsert
                confirm_response = supabase.table("storeinventory").select("id, quantity").eq("storeid", store_id).eq(
                    "productid", item_product_id
                ).limit(1).execute()
                if not confirm_response.data:
                    raise Exception("Inventory row not found after upsert")
                inventory_applied = True
                local_inventory_deltas[product_key] = int(local_inventory_deltas.get(product_key, 0)) + int(delta_verified)
            except Exception as inv_error:
                inventory_error_message = str(inv_error)
                app.logger.error(
                    f"❌ Inventory upsert failed for product {item_product_id} in order {order_id}: {inv_error}"
                )

            inventory_results.append(
                {
                    "transfer_item_id": item.get("id"),
                    "product_id": item_product_id,
                    "delta_verified": delta_verified,
                    "success": inventory_applied,
                    "message": None if inventory_applied else (inventory_error_message or "Failed to add to store inventory."),
                }
            )

        damaged_delta = max(0, new_damaged - old_damaged)
        if damaged_delta > 0:
            damaged_event_rows.append(
                {
                    "id": f"DMG-{datetime.now(timezone.utc).timestamp()}-{item.get('id')}",
                    "store_id": store_id,
                    "product_id": _get_transfer_item_product_id(item),
                    "quantity": damaged_delta,
                    "source_type": "transfer_verification",
                    "source_id": item.get("id"),
                    "reason": update.get("damage_reason") or "Damaged during transfer verification",
                    "status": "reported",
                    "reported_by": current_user_id,
                    "created_at": now_iso,
                    "updated_at": now_iso,
                }
            )

        # Persist verified_qty regardless of inventory write outcome.
        # applied_verified_qty only advances when inventory write succeeded, so any
        # residual delta (verified_qty - applied_verified_qty) stays available for
        # the reconciliation pass to pick up and retry safely.
        applied_verified_after = old_applied_verified + (delta_verified if inventory_applied else 0)
        item_payload = {
            "verified_qty": new_verified,
            "damaged_qty": new_damaged,
            "wrong_store_qty": new_wrong,
            "applied_verified_qty": applied_verified_after,
            "status": _derive_transfer_item_state(
                {
                    "assigned_qty": assigned_qty,
                    "verified_qty": new_verified,
                    "damaged_qty": new_damaged,
                    "wrong_store_qty": new_wrong,
                }
            ),
            "updated_at": now_iso,
        }
        try:
            supabase.table("inventory_transfer_items").update(item_payload).eq("id", item.get("id")).execute()
        except Exception as persist_err:
            app.logger.error(f"❌ Failed to persist transfer item {item.get('id')}: {persist_err}")
        updated_items.append(
            {
                "item_id": item.get("id"),
                **item_payload,
                "delta_verified_requested": delta_verified,
                "delta_verified_applied": delta_verified if inventory_applied else 0,
                "inventory_applied": inventory_applied,
            }
        )

    if local_inventory_deltas:
        for product_id, delta_qty in local_inventory_deltas.items():
            _update_local_storeinventory(store_id, product_id, int(delta_qty), now_iso)

    if scans:
        scan_rows = []
        for scan in scans:
            scan_rows.append(
                {
                    "id": f"SCAN-{datetime.now(timezone.utc).timestamp()}",
                    "transfer_item_id": scan.get("transfer_item_id") or scan.get("transferItemId"),
                    "barcode": scan.get("barcode"),
                    "quantity": int(scan.get("quantity") or 1),
                    "entry_mode": scan.get("entry_mode") or scan.get("entryMode") or "manual",
                    "event_type": scan.get("event_type") or scan.get("eventType") or "verified",
                    "entered_by": current_user_id,
                    "created_at": now_iso,
                }
            )
        if scan_rows:
            supabase.table("inventory_transfer_scans").insert(scan_rows).execute()

    if damaged_event_rows:
        supabase.table("damaged_inventory_events").insert(damaged_event_rows).execute()

    refreshed_items_response = supabase.table("inventory_transfer_items").select("*").eq(
        "transfer_order_id", order_id
    ).execute()
    refreshed_items = refreshed_items_response.data or []
    assigned_total = sum(int(i.get("assigned_qty") or 0) for i in refreshed_items)
    verified_total = sum(int(i.get("verified_qty") or 0) for i in refreshed_items)
    damaged_total = sum(int(i.get("damaged_qty") or 0) for i in refreshed_items)
    wrong_total = sum(int(i.get("wrong_store_qty") or 0) for i in refreshed_items)
    missing_total = max(0, assigned_total - verified_total - damaged_total - wrong_total)
    order_status = "pending"
    if missing_total == 0 and assigned_total > 0:
        order_status = "closed_with_issues" if (damaged_total > 0 or wrong_total > 0) else "completed"
    elif verified_total > 0 or damaged_total > 0 or wrong_total > 0:
        order_status = "in_progress"

    order_update = {
        "status": order_status,
        "version_number": int(order.get("version_number") or 1) + 1,
        "updated_at": now_iso,
        "verified_at": now_iso if order_status in ["completed", "closed_with_issues"] else None,
    }
    supabase.table("inventory_transfer_orders").update(order_update).eq("id", order_id).execute()
    supabase.table("inventory_transfer_verifications").update(
        {"status": "applied", "error_message": None}
    ).eq("verification_session_id", session_id).execute()

    return {
        "message": "Verification applied successfully",
        "verification_session_id": session_id,
        "order_status": order_status,
        "summary": {
            "assigned_qty_total": assigned_total,
            "verified_qty_total": verified_total,
            "damaged_qty_total": damaged_total,
            "wrong_store_qty_total": wrong_total,
            "missing_qty_total": missing_total,
        },
        "updated_items": updated_items,
        "inventory_results": inventory_results,
    }, 200


@store_bp.route('/transfer-orders/<order_id>/verify', methods=['POST'])
@require_auth
def verify_transfer_order(order_id):
    """Verify one transfer order with idempotent session and delta application to inventory."""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json() or {}
        supabase = get_supabase_client()
        store_id = _get_current_store_id(supabase, current_user_id)
        if not store_id:
            return jsonify({"message": "No store assigned to this user"}), 404

        try:
            result, status_code = _apply_transfer_order_verification(
                supabase=supabase,
                current_user_id=current_user_id,
                store_id=store_id,
                order_id=order_id,
                data=data,
            )
            return jsonify(result), status_code
        except Exception as apply_error:
            queue_info = enqueue_transfer_verification_create(
                user_id=current_user_id,
                store_id=store_id,
                order_id=order_id,
                verification_data=data,
            )
            app.logger.warning(
                f"⚠️ Transfer verification queued for order {order_id} due to cloud error: {apply_error}"
            )
            return jsonify(
                {
                    "message": "System offline. Transfer verification queued and will sync automatically.",
                    "queued": True,
                    "queue_id": queue_info["queue_id"],
                    "verification_session_id": queue_info["verification_session_id"],
                }
            ), 202
    except Exception as e:
        app.logger.error(f"❌ Error verifying transfer order {order_id}: {str(e)}")
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@store_bp.route('/transfer-orders/verify-batch', methods=['POST'])
@require_auth
def verify_transfer_orders_batch():
    """Verify multiple transfer orders in one request."""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json() or {}
        verifications = data.get("verifications") or []
        batch_session_id = data.get("verification_session_id")
        if not batch_session_id:
            return jsonify({"message": "verification_session_id is required"}), 400
        if not verifications:
            return jsonify({"message": "verifications array is required"}), 400

        supabase = get_supabase_client()
        store_id = _get_current_store_id(supabase, current_user_id)
        if not store_id:
            return jsonify({"message": "No store assigned to this user"}), 404

        results = []
        success_count = 0
        failed_count = 0
        duplicate_count = 0
        queued_count = 0

        for index, verification in enumerate(verifications):
            order_id = verification.get("order_id") or verification.get("orderId")
            if not order_id:
                failed_count += 1
                results.append(
                    {"index": index, "status": "failed", "message": "order_id is required", "status_code": 400}
                )
                continue

            order_payload = {
                "verification_session_id": f"{batch_session_id}-{order_id}",
                "items": verification.get("items", []) or [],
                "scans": verification.get("scans", []) or [],
            }
            try:
                result, status_code = _apply_transfer_order_verification(
                    supabase=supabase,
                    current_user_id=current_user_id,
                    store_id=store_id,
                    order_id=order_id,
                    data=order_payload,
                )
            except Exception as apply_error:
                queue_info = enqueue_transfer_verification_create(
                    user_id=current_user_id,
                    store_id=store_id,
                    order_id=order_id,
                    verification_data=order_payload,
                )
                queued_count += 1
                results.append(
                    {
                        "index": index,
                        "order_id": order_id,
                        "status": "queued",
                        "status_code": 202,
                        "message": "System offline. Verification queued and will sync automatically.",
                        "queued": True,
                        "queue_id": queue_info["queue_id"],
                        "verification_session_id": queue_info["verification_session_id"],
                        "error": str(apply_error),
                    }
                )
                continue

            row_status = "success" if status_code < 300 else "failed"
            if result.get("status") == "duplicate_ignored":
                row_status = "duplicate_ignored"
                duplicate_count += 1
            elif row_status == "success":
                success_count += 1
            else:
                failed_count += 1

            results.append(
                {
                    "index": index,
                    "order_id": order_id,
                    "status": row_status,
                    "status_code": status_code,
                    **result,
                }
            )

        response_status = 200 if failed_count == 0 else (207 if success_count > 0 or duplicate_count > 0 or queued_count > 0 else 400)
        if failed_count == 0 and queued_count > 0 and success_count == 0 and duplicate_count == 0:
            response_status = 202
        reconcile_summary = None
        try:
            reconcile_summary = _reconcile_store_inventory(supabase, store_id)
        except Exception as rec_err:
            app.logger.warning(f"⚠️ Post-batch inventory reconcile failed: {rec_err}")

        return jsonify(
            {
                "message": "Batch verification processed",
                "verification_session_id": batch_session_id,
                "success_count": success_count,
                "failed_count": failed_count,
                "duplicate_count": duplicate_count,
                "queued_count": queued_count,
                "queued": queued_count > 0,
                "results": results,
                "reconcile": reconcile_summary,
            }
        ), response_status
    except Exception as e:
        app.logger.error(f"❌ Error verifying transfer orders in batch: {str(e)}")
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


def _reconcile_store_inventory(supabase, store_id: str, repair_missing_inventory_rows: bool = True) -> dict:
    """
    Delta-based inventory reconciliation for a single store.

    Idempotency rule:
    - Primary path: only rows where `verified_qty > applied_verified_qty` are processed,
      and `applied_verified_qty` is advanced only on successful inventory write.
    - Drift-repair path (optional): when an item has no delta but appears previously
      applied (`applied_verified_qty > 0`) and inventory row is missing, recreate the
      missing inventory row with the already-applied quantity once.
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    order_response = (
        supabase.table("inventory_transfer_orders")
        .select("id")
        .eq("store_id", store_id)
        .execute()
    )
    order_ids = [o.get("id") for o in (order_response.data or []) if o.get("id")]
    if not order_ids:
        return {
            "items_considered": 0,
            "items_applied": 0,
            "items_failed": 0,
            "delta_applied_total": 0,
            "results": [],
        }

    items: list = []
    chunk_fetch_errors = []
    for chunk in _chunk_list(order_ids, 100):
        try:
            response = (
                supabase.table("inventory_transfer_items")
                .select("*")
                .in_("transfer_order_id", chunk)
                .execute()
            )
            items.extend(response.data or [])
        except Exception as chunk_err:
            app.logger.warning(f"⚠️ Failed to fetch transfer items chunk during reconcile: {chunk_err}")
            chunk_fetch_errors.append(str(chunk_err))

    results = []
    items_considered = 0
    items_applied = 0
    items_failed = 0
    delta_applied_total = 0
    drift_repairs = 0
    if not items and chunk_fetch_errors:
        return {
            "items_considered": 0,
            "items_applied": 0,
            "items_failed": len(chunk_fetch_errors),
            "delta_applied_total": 0,
            "drift_repairs": 0,
            "results": [
                {
                    "transfer_item_id": None,
                    "product_id": None,
                    "delta": 0,
                    "success": False,
                    "reason": "fetch_failed",
                    "message": msg,
                }
                for msg in chunk_fetch_errors
            ],
        }

    for item in items:
        product_id = _get_transfer_item_product_id(item)
        verified_qty = int(item.get("verified_qty") or 0)
        applied_verified = _get_transfer_item_applied_verified_qty(item)
        delta = max(0, verified_qty - applied_verified)
        apply_verified_bump = True
        reason = "delta_unapplied_verified"

        if not product_id:
            continue

        if delta <= 0:
            if not repair_missing_inventory_rows:
                continue
            if verified_qty <= 0 or applied_verified <= 0:
                continue
            try:
                inv_exists_response = (
                    supabase.table("storeinventory")
                    .select("id")
                    .eq("storeid", store_id)
                    .eq("productid", product_id)
                    .limit(1)
                    .execute()
                )
                if inv_exists_response.data:
                    continue
            except Exception as exists_err:
                app.logger.warning(
                    f"⚠️ Drift-check failed for transfer_item {item.get('id')} / product {product_id}: {exists_err}"
                )
                continue

            # Historical drift repair: row marked as applied but inventory row is absent.
            delta = applied_verified
            apply_verified_bump = False
            reason = "missing_inventory_row_drift_repair"

        items_considered += 1

        applied_ok = False
        error_message = None
        try:
            inv_response = (
                supabase.table("storeinventory")
                .select("id, quantity")
                .eq("storeid", store_id)
                .eq("productid", product_id)
                .limit(1)
                .execute()
            )
            if inv_response.data:
                inv = inv_response.data[0]
                new_qty = int(inv.get("quantity") or 0) + delta
                supabase.table("storeinventory").update(
                    {"quantity": new_qty, "updatedat": now_iso}
                ).eq("id", inv.get("id")).execute()
            else:
                supabase.table("storeinventory").insert(
                    {
                        "id": f"INV-{datetime.now(timezone.utc).timestamp()}-{product_id}",
                        "storeid": store_id,
                        "productid": product_id,
                        "quantity": delta,
                        "assignedat": now_iso,
                        "updatedat": now_iso,
                    }
                ).execute()

            confirm_response = (
                supabase.table("storeinventory")
                .select("id")
                .eq("storeid", store_id)
                .eq("productid", product_id)
                .limit(1)
                .execute()
            )
            if not confirm_response.data:
                raise Exception("Inventory row not found after reconcile upsert")

            if apply_verified_bump:
                supabase.table("inventory_transfer_items").update(
                    {"applied_verified_qty": applied_verified + delta, "updated_at": now_iso}
                ).eq("id", item.get("id")).execute()
            else:
                drift_repairs += 1

            _update_local_storeinventory(store_id, product_id, int(delta), now_iso)
            applied_ok = True
            items_applied += 1
            delta_applied_total += delta
        except Exception as rec_err:
            error_message = str(rec_err)
            items_failed += 1
            app.logger.error(
                f"❌ Reconcile failed for transfer_item {item.get('id')} / product {product_id}: {rec_err}"
            )

        results.append(
            {
                "transfer_item_id": item.get("id"),
                "product_id": product_id,
                "delta": delta,
                "success": applied_ok,
                "reason": reason,
                "message": None if applied_ok else (error_message or "Reconcile failed"),
            }
        )

    return {
        "items_considered": items_considered,
        "items_applied": items_applied,
        "items_failed": items_failed,
        "delta_applied_total": delta_applied_total,
        "drift_repairs": drift_repairs,
        "results": results,
    }


@store_bp.route('/stores/current/transfer-orders/reconcile-inventory', methods=['POST'])
@require_auth
def reconcile_store_inventory_route():
    """Manually trigger delta-based inventory reconciliation for the current store."""
    try:
        current_user_id = get_jwt_identity()
        supabase = get_supabase_client()
        store_id = _get_current_store_id(supabase, current_user_id)
        if not store_id:
            return jsonify({"message": "No store assigned to this user"}), 404

        body = request.get_json(silent=True) or {}
        repair_missing_rows = bool(body.get("repair_missing_inventory_rows", True))
        summary = _reconcile_store_inventory(
            supabase, store_id, repair_missing_inventory_rows=repair_missing_rows
        )
        status_code = 200 if summary.get("items_failed", 0) == 0 else 207
        return jsonify({"message": "Reconciliation complete", **summary}), status_code
    except Exception as e:
        app.logger.error(f"❌ Error reconciling store inventory: {str(e)}")
        return jsonify({"message": "An error occurred", "error": str(e)}), 500
