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

@store_bp.route('/stores', methods=['GET'])
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
        user_stores = read_json_file(USER_STORES_FILE, [])
        assigned = next(
            (
                _normalize_user_store_row(u)
                for u in user_stores
                if str(u.get("userId") or u.get("userid")) == str(current_user_id)
            ),
            None,
        )
        if not assigned:
            return jsonify({"message": "No store assigned to this user"}), 404
        stores = read_json_file(STORES_FILE, [])
        store = next((s for s in stores if str(s.get("id")) == str(assigned.get("storeId") or assigned.get("storeid"))), None)
        if not store:
            return jsonify({"message": "Store not found"}), 404
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
    items_by_product = {item.get("product_id"): item for item in items if item.get("product_id")}
    now_iso = datetime.now(timezone.utc).isoformat()
    updated_items = []
    damaged_event_rows = []
    local_inventory_deltas = {}

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
        old_applied_verified = int(item.get("applied_verified_qty") or 0)

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
        if delta_verified > 0:
            product_key = str(item.get("product_id"))
            local_inventory_deltas[product_key] = int(local_inventory_deltas.get(product_key, 0)) + int(delta_verified)
            inv_response = supabase.table("storeinventory").select("*").eq("storeid", store_id).eq(
                "productid", item.get("product_id")
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
                        "id": f"INV-{datetime.now(timezone.utc).timestamp()}-{item.get('product_id')}",
                        "storeid": store_id,
                        "productid": item.get("product_id"),
                        "quantity": delta_verified,
                        "assignedat": now_iso,
                        "updatedat": now_iso,
                    }
                ).execute()

        damaged_delta = max(0, new_damaged - old_damaged)
        if damaged_delta > 0:
            damaged_event_rows.append(
                {
                    "id": f"DMG-{datetime.now(timezone.utc).timestamp()}-{item.get('id')}",
                    "store_id": store_id,
                    "product_id": item.get("product_id"),
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

        item_payload = {
            "verified_qty": new_verified,
            "damaged_qty": new_damaged,
            "wrong_store_qty": new_wrong,
            "applied_verified_qty": old_applied_verified + delta_verified,
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
        supabase.table("inventory_transfer_items").update(item_payload).eq("id", item.get("id")).execute()
        updated_items.append({"item_id": item.get("id"), **item_payload, "delta_verified_applied": delta_verified})

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
            }
        ), response_status
    except Exception as e:
        app.logger.error(f"❌ Error verifying transfer orders in batch: {str(e)}")
        return jsonify({"message": "An error occurred", "error": str(e)}), 500
