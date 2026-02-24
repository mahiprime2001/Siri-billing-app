from flask import Blueprint, jsonify, current_app as app, request
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client
from datetime import datetime, timezone
import hashlib
from helpers.utils import read_json_file
from config.config import STORES_FILE, USER_STORES_FILE

store_bp = Blueprint('store', __name__)


def _get_current_store_id(supabase, user_id: str):
    user_stores_response = supabase.table('userstores') \
        .select('storeId') \
        .eq('userId', user_id) \
        .execute()
    if not user_stores_response.data:
        return None
    return user_stores_response.data[0].get('storeId')


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
        
        # ✅ Query userstores table with correct column names
        response = supabase.table('userstores') \
            .select('userId, storeId, created_at, updated_at') \
            .eq('userId', current_user_id) \
            .execute()
        
        user_stores = response.data if response.data else []
        
        app.logger.info(f"✅ Found {len(user_stores)} user-store associations for user {current_user_id}")
        app.logger.debug(f"User-stores data: {user_stores}")
        
        return jsonify(user_stores), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching user stores: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        user_stores = read_json_file(USER_STORES_FILE, [])
        user_stores = [u for u in user_stores if str(u.get("userId")) == str(current_user_id)]
        return jsonify(user_stores), 200


@store_bp.route('/stores/current', methods=['GET'])
@require_auth
def get_current_user_store():
    """Get the store assigned to the current user (with full store details)"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"📍 User {current_user_id} fetching their assigned store")
        
        supabase = get_supabase_client()
        
        # Get user's store ID
        user_stores_response = supabase.table('userstores') \
            .select('storeId') \
            .eq('userId', current_user_id) \
            .execute()
        
        if not user_stores_response.data or len(user_stores_response.data) == 0:
            app.logger.warning(f"⚠️ No store assigned to user {current_user_id}")
            return jsonify({"message": "No store assigned to this user"}), 404
        
        store_id = user_stores_response.data[0]['storeId']
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
        assigned = next((u for u in user_stores if str(u.get("userId")) == str(current_user_id)), None)
        if not assigned:
            return jsonify({"message": "No store assigned to this user"}), 404
        stores = read_json_file(STORES_FILE, [])
        store = next((s for s in stores if str(s.get("id")) == str(assigned.get("storeId"))), None)
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

        items_response = supabase.table("inventory_transfer_items").select("*, products(name, barcode)").eq(
            "transfer_order_id", order_id
        ).execute()
        items = items_response.data or []
        normalized_items = []
        for item in items:
            assigned = int(item.get("assigned_qty") or 0)
            verified = int(item.get("verified_qty") or 0)
            damaged = int(item.get("damaged_qty") or 0)
            wrong_store = int(item.get("wrong_store_qty") or 0)
            missing = max(0, assigned - verified - damaged - wrong_store)
            normalized_items.append(
                {
                    **item,
                    "missing_qty": missing,
                    "status": _derive_transfer_item_state(item),
                }
            )

        order["items"] = normalized_items
        return jsonify(order), 200
    except Exception as e:
        app.logger.error(f"❌ Error fetching transfer order {order_id}: {str(e)}")
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@store_bp.route('/transfer-orders/<order_id>/verify', methods=['POST'])
@require_auth
def verify_transfer_order(order_id):
    """Verify transfer items with idempotent session and delta application to storeinventory."""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json() or {}
        session_id = data.get("verification_session_id")
        item_updates = data.get("items", []) or []
        scans = data.get("scans", []) or []
        if not session_id:
            return jsonify({"message": "verification_session_id is required"}), 400

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
        if order.get("status") in ["completed", "closed_with_issues", "cancelled"]:
            return jsonify({"message": "Transfer order already closed"}), 409

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
                return jsonify(
                    {
                        "message": "Duplicate verification ignored",
                        "status": "duplicate_ignored",
                        "verification_session_id": session_id,
                    }
                ), 200
            raise

        items_response = supabase.table("inventory_transfer_items").select("*").eq("transfer_order_id", order_id).execute()
        items = items_response.data or []
        if not items:
            return jsonify({"message": "No transfer items found"}), 400

        items_by_id = {item.get("id"): item for item in items if item.get("id")}
        items_by_product = {item.get("product_id"): item for item in items if item.get("product_id")}
        now_iso = datetime.now(timezone.utc).isoformat()
        updated_items = []
        damaged_event_rows = []

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

        return jsonify(
            {
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
            }
        ), 200
    except Exception as e:
        app.logger.error(f"❌ Error verifying transfer order {order_id}: {str(e)}")
        return jsonify({"message": "An error occurred", "error": str(e)}), 500
