from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client
from data_access.data_access import update_both_inventory_and_product_stock
from datetime import datetime, timezone
import uuid
import traceback
from helpers.utils import read_json_file, write_json_file
from config.config import STORE_DAMAGE_RETURNS_FILE, PRODUCTS_FILE, STOREINVENTORY_FILE, USER_STORES_FILE
from utils.offline_damage_return_queue import enqueue_damage_return_create

return_bp = Blueprint('return', __name__)


def _resolve_current_store_id(supabase, user_id: str):
    try:
        user_store_response = (
            supabase.table("userstores").select("storeId").eq("userId", user_id).limit(1).execute()
        )
        if user_store_response.data:
            return user_store_response.data[0].get("storeId")
    except Exception:
        pass

    # Offline fallback
    user_stores = read_json_file(USER_STORES_FILE, [])
    match = next((row for row in user_stores if str(row.get("userId")) == str(user_id)), None)
    return match.get("storeId") if match else None


def _apply_local_stock_reduction(store_id: str, product_id: str, quantity: int) -> None:
    """Offline fallback: update local JSON snapshots immediately."""
    if quantity <= 0:
        return

    products = read_json_file(PRODUCTS_FILE, [])
    for product in products:
        if str(product.get("id")) == str(product_id):
            current_stock = int(product.get("stock") or 0)
            product["stock"] = max(0, current_stock - quantity)
            product["updatedat"] = datetime.now(timezone.utc).isoformat()
            break
    write_json_file(PRODUCTS_FILE, products)

    inventory = read_json_file(STOREINVENTORY_FILE, [])
    for row in inventory:
        if str(row.get("storeid")) == str(store_id) and str(row.get("productid")) == str(product_id):
            current_qty = int(row.get("quantity") or 0)
            row["quantity"] = max(0, current_qty - quantity)
            row["updatedat"] = datetime.now(timezone.utc).isoformat()
            break
    write_json_file(STOREINVENTORY_FILE, inventory)


@return_bp.route('/returns', methods=['GET'])
@require_auth
def get_returns():
    """Get all returns with product and customer details via JOIN"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching returns")
        
        status = request.args.get('status')
        store_id = request.args.get('store_id')
        limit = request.args.get('limit', 100, type=int)
        
        supabase = get_supabase_client()
        
        # ✅ JOIN with products and customers to get names
        query = supabase.table('returns').select(
            '*, products(id, name, selling_price), customers(id, name, phone)'
        )
        
        if status:
            query = query.eq('status', status)
        
        if store_id:
            query = query.eq('store_id', store_id)
        
        response = query.limit(limit).order('created_at', desc=True).execute()
        returns = response.data if response.data else []
        
        # ✅ Transform to include product_name from JOIN (null-safe)
        transformed_returns = []
        for ret in returns:
            product_data = ret.get('products') or {}  # ✅ Handle None
            customer_data = ret.get('customers') or {}  # ✅ Handle None
            
            transformed_returns.append({
                **ret,
                'product_name': product_data.get('name', 'Unknown Product'),
                'customer_name': customer_data.get('name', 'Walk-in Customer'),
                'customer_phone': customer_data.get('phone', '')
            })
        
        app.logger.info(f"✅ Fetched {len(transformed_returns)} returns")
        
        return jsonify(transformed_returns), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching returns: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred"}), 500


@return_bp.route('/returns/search', methods=['POST'])
@require_auth
def search_bills():
    """Search bills for return processing"""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json()
        
        query = data.get('query', '').strip()
        search_type = data.get('searchType', 'all')
        
        app.logger.info(f"🔍 User {current_user_id} searching bills: {query} ({search_type})")
        
        if not query:
            return jsonify([]), 200
        
        supabase = get_supabase_client()
        
        bills_map = {}

        def add_bills(rows):
            for row in (rows or []):
                if row and row.get('id'):
                    bills_map[row['id']] = row

        # Backward compatibility for explicit searchType values.
        if search_type in ('customer', 'all'):
            customer_response = supabase.table('customers').select('id').ilike('name', f'%{query}%').execute()
            customer_ids = [c['id'] for c in (customer_response.data or []) if c.get('id')]
            if customer_ids:
                customer_bills = supabase.table('bills').select(
                    '*, customers(id, name, phone)'
                ).in_('customerid', customer_ids).execute()
                add_bills(customer_bills.data)

        if search_type in ('phone', 'all'):
            phone_response = supabase.table('customers').select('id').ilike('phone', f'%{query}%').execute()
            customer_ids = [c['id'] for c in (phone_response.data or []) if c.get('id')]
            if customer_ids:
                phone_bills = supabase.table('bills').select(
                    '*, customers(id, name, phone)'
                ).in_('customerid', customer_ids).execute()
                add_bills(phone_bills.data)

        if search_type in ('invoice', 'all'):
            invoice_bills = supabase.table('bills').select(
                '*, customers(id, name, phone)'
            ).ilike('id', f'%{query}%').execute()
            add_bills(invoice_bills.data)

        if search_type not in ('customer', 'phone', 'invoice', 'all'):
            return jsonify({"message": "Invalid search type"}), 400

        bills = list(bills_map.values())
        
        # ✅ Transform bills to include items with product names via JOIN
        transformed_bills = []
        for bill in bills:
            # Get bill items with product details via JOIN
            bill_items_response = supabase.table('billitems').select(
                '*, products(id, name, selling_price)'
            ).eq('billid', bill['id']).execute()
            
            bill_items = bill_items_response.data if bill_items_response.data else []
            
            customer_data = bill.get('customers') or {}
            
            transformed_bills.append({
                'id': bill['id'],
                'storeId': bill.get('storeid') or bill.get('storeId') or '',
                'customerId': bill.get('customerid', ''),
                'customerName': customer_data.get('name', 'Walk-in Customer'),
                'customerPhone': customer_data.get('phone', ''),
                'paymentMethod': bill.get('paymentmethod', 'cash'),
                'total': float(bill.get('total', 0)),
                'timestamp': bill.get('timestamp', bill.get('created_at', '')),
                'items': [{
                    'productId': item.get('productid', ''),
                    'productName': item.get('products', {}).get('name', 'Unknown Product'),
                    'price': float(item.get('price', 0)),
                    'quantity': int(item.get('quantity', 0)),
                    'total': float(item.get('total', 0))
                } for item in bill_items]
            })
        
        app.logger.info(f"✅ Found {len(transformed_bills)} bills")
        
        return jsonify(transformed_bills), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error searching bills: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred"}), 500


@return_bp.route('/returns/submit', methods=['POST'])
@require_auth
def submit_return():
    """Submit return request - only stores product_id and customer_id"""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json()
        
        selected_items = data.get('selectedItems', [])
        return_reason = data.get('returnReason', '')
        refund_method = data.get('refundMethod', 'cash')
        search_results = data.get('searchResults', [])
        created_by = data.get('createdBy', 'Unknown')
        
        app.logger.info(f"📦 User {current_user_id} submitting return with {len(selected_items)} items")
        
        if not selected_items or not return_reason:
            return jsonify({"message": "Missing required fields"}), 400
        
        supabase = get_supabase_client()
        created_returns = []
        
        # Create return for each selected item
        for selected_item in selected_items:
            # Parse item ID (format: billId-itemIndex)
            item_id = selected_item['id']
            last_hyphen = item_id.rfind('-')
            bill_id = item_id[:last_hyphen]
            item_index = int(item_id[last_hyphen + 1:])
            
            # Find the bill and item
            bill = next((b for b in search_results if b['id'] == bill_id), None)
            
            if not bill or item_index >= len(bill['items']):
                app.logger.warning(f"⚠️ Bill or item not found: {bill_id}, index {item_index}")
                continue
            
            item = bill['items'][item_index]
            return_quantity = selected_item.get('quantity', 1)
            original_quantity = item['quantity']
            unit_price = item['price']
            product_id = item['productId']
            customer_id = bill.get('customerId', None)
            store_id = bill.get('storeId') or None
            selected_reason = selected_item.get('reason') or return_reason
            is_damaged = bool(selected_item.get('isDamaged')) or ("damaged" in (selected_reason or "").lower())
            damaged_qty = int(selected_item.get('damagedQuantity') or 0)
            if is_damaged and damaged_qty <= 0:
                damaged_qty = return_quantity
            
            return_id = f"RET-{uuid.uuid4().hex[:12].upper()}"
            
            # ✅ Only store IDs - no product_name needed
            return_data = {
                'return_id': return_id,
                'product_id': product_id,
                'customer_id': customer_id,
                'message': return_reason,
                'refund_method': refund_method,
                'bill_id': bill_id,
                'store_id': store_id,
                'original_quantity': original_quantity,
                'return_quantity': return_quantity,
                'return_amount': unit_price * return_quantity,
                'status': 'pending',
                'is_damaged': is_damaged,
                'damaged_qty': damaged_qty if is_damaged else 0,
                'damage_reason': selected_reason if is_damaged else None,
                'created_by': created_by,
                'created_at': datetime.now(timezone.utc).isoformat(),
                'updated_at': datetime.now(timezone.utc).isoformat()
            }
            
            app.logger.info(f"📝 Creating return: {return_id}")
            app.logger.info(f"   Product ID: {product_id}")
            app.logger.info(f"   Customer ID: {customer_id}")
            app.logger.info(f"   Quantity: {return_quantity}/{original_quantity}")
            
            response = supabase.table('returns').insert(return_data).execute()
            
            if response.data:
                created_returns.append(response.data[0])
                app.logger.info(f"✅ Created return: {return_id}")
                if is_damaged and damaged_qty > 0:
                    try:
                        now_iso = datetime.now(timezone.utc).isoformat()
                        supabase.table('damaged_inventory_events').insert(
                            {
                                "id": f"DMG-{uuid.uuid4().hex[:12].upper()}",
                                "store_id": store_id,
                                "product_id": product_id,
                                "quantity": damaged_qty,
                                "source_type": "return",
                                "source_id": return_id,
                                "reason": selected_reason or "Product is damaged",
                                "status": "reported",
                                "reported_by": current_user_id,
                                "created_at": now_iso,
                                "updated_at": now_iso,
                            }
                        ).execute()
                    except Exception as damaged_error:
                        app.logger.warning(f"⚠️ Failed to insert damaged event for return {return_id}: {damaged_error}")
            else:
                app.logger.error(f"❌ Failed to create return for item {item_id}")
        
        if not created_returns:
            return jsonify({"message": "No returns were created"}), 400
        
        app.logger.info(f"✅ Created {len(created_returns)} return requests")
        
        return jsonify({
            "message": "Return requests submitted successfully",
            "returnId": created_returns[0]['return_id'] if created_returns else None,
            "count": len(created_returns)
        }), 201
        
    except Exception as e:
        app.logger.error(f"❌ Error submitting return: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@return_bp.route('/returns/<return_id>/approve', methods=['POST'])
@require_auth
def approve_return(return_id):
    """Approve a return request and create notification"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"✅ User {current_user_id} approving return {return_id}")
        
        supabase = get_supabase_client()
        
        # Update return status
        update_data = {
            'status': 'approved',
            'approved_by': current_user_id,
            'approved_at': datetime.now(timezone.utc).isoformat(),
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        response = supabase.table('returns').update(update_data).eq('return_id', return_id).execute()
        
        if not response.data or len(response.data) == 0:
            return jsonify({"message": "Return not found"}), 404
        
        return_data = response.data[0]

        # 🏬 Restock only the non‑damaged quantity
        try:
            restock_qty = max(
                0,
                int(return_data.get('return_quantity') or 0)
                - (int(return_data.get('damaged_qty') or 0) if return_data.get('is_damaged') else 0),
            )
            if restock_qty > 0 and return_data.get('product_id') and return_data.get('store_id'):
                updated = update_both_inventory_and_product_stock(
                    store_id=return_data['store_id'],
                    product_id=return_data['product_id'],
                    quantity_sold=-restock_qty,
                )
                if not updated:
                    app.logger.warning(
                        f"⚠️ Restock failed for return {return_id} (product {return_data.get('product_id')})"
                    )
        except Exception as inventory_error:
            app.logger.error(f"❌ Inventory update failed for return {return_id}: {inventory_error}")
        
        # ✅ Fetch product name for notification
        product_name = 'Product'
        if return_data.get('product_id'):
            product_response = supabase.table('products').select('name').eq('id', return_data['product_id']).execute()
            if product_response.data:
                product_name = product_response.data[0]['name']
        
        # ✅ Create notification
        notification_data = {
            'type': 'return_approved',
            'notification': f"Return approved for {product_name} - ₹{return_data.get('return_amount', 0)} (Qty: {return_data.get('return_quantity', 0)})",
            'related_id': return_id,
            'is_read': False,
            'created_at': datetime.now(timezone.utc).isoformat(),
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        supabase.table('notifications').insert(notification_data).execute()
        
        app.logger.info(f"✅ Return {return_id} approved and notification created")
        
        return jsonify(return_data), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error approving return: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred"}), 500


@return_bp.route('/returns/<return_id>/deny', methods=['POST'])
@require_auth
def deny_return(return_id):
    """Deny a return request"""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json()
        reason = data.get('reason', '')
        
        app.logger.info(f"❌ User {current_user_id} denying return {return_id}")
        
        if not reason:
            return jsonify({"message": "Denial reason required"}), 400
        
        supabase = get_supabase_client()
        
        update_data = {
            'status': 'denied',
            'denial_reason': reason,
            'denied_by': current_user_id,
            'denied_at': datetime.now(timezone.utc).isoformat(),
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        response = supabase.table('returns').update(update_data).eq('return_id', return_id).execute()
        
        if not response.data or len(response.data) == 0:
            return jsonify({"message": "Return not found"}), 404
        
        app.logger.info(f"✅ Return {return_id} denied")
        
        return jsonify(response.data[0]), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error denying return: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred"}), 500


@return_bp.route('/returns/pending/count', methods=['GET'])
@require_auth
def get_pending_returns_count():
    """Get count of pending returns"""
    try:
        current_user_id = get_jwt_identity()
        
        supabase = get_supabase_client()
        response = supabase.table('returns').select('return_id', count='exact').eq('status', 'pending').execute()
        
        count = response.count if hasattr(response, 'count') else len(response.data or [])
        
        app.logger.debug(f"📊 User {current_user_id} fetched pending returns count: {count}")
        
        return jsonify({"count": count}), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching pending returns count: {str(e)}")
        return jsonify({"message": "An error occurred"}), 500


@return_bp.route('/store-damage-returns', methods=['GET'])
@require_auth
def get_store_damage_returns():
    """List damage-return rows for current store user."""
    try:
        current_user_id = get_jwt_identity()
        status = request.args.get("status")
        limit = request.args.get("limit", 100, type=int)

        supabase = get_supabase_client()
        store_id = _resolve_current_store_id(supabase, current_user_id)
        if not store_id:
            return jsonify([]), 200

        query = supabase.table("store_damage_returns").select(
            "*, products(id, name, barcode), stores(id, name)"
        ).eq("store_id", store_id)
        if status:
            query = query.eq("status", status)
        response = query.order("created_at", desc=True).limit(limit).execute()
        return jsonify(response.data or []), 200
    except Exception as e:
        app.logger.error(f"❌ Error fetching store damage returns: {str(e)}")
        app.logger.error(traceback.format_exc())
        rows = read_json_file(STORE_DAMAGE_RETURNS_FILE, [])
        return jsonify(rows[:limit]), 200


@return_bp.route('/store-damage-returns', methods=['POST'])
@require_auth
def create_store_damage_return():
    """
    Create a new damage-return row.
    Business rule: decrement storeinventory + global products stock at submit time.
    """
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json() or {}
        selected_items = data.get("selectedItems", []) or []
        reason = (data.get("reason") or "").strip()
        damage_origin = (data.get("damageOrigin") or "store").strip().lower()

        if damage_origin not in {"store", "transport"}:
            return jsonify({"message": "damageOrigin must be 'store' or 'transport'"}), 400
        if not selected_items:
            return jsonify({"message": "selectedItems is required"}), 400
        if not reason:
            return jsonify({"message": "reason is required"}), 400

        supabase = get_supabase_client()
        store_id = _resolve_current_store_id(supabase, current_user_id)
        if not store_id:
            return jsonify({"message": "No store assigned to this user"}), 404

        created_rows = []
        now_iso = datetime.now(timezone.utc).isoformat()

        for item in selected_items:
            product_id = item.get("productId") or item.get("product_id")
            quantity = int(item.get("quantity") or 0)
            note = item.get("note") or data.get("note") or ""
            if not product_id or quantity <= 0:
                continue

            row = {
                "id": f"SDR-{uuid.uuid4().hex[:12].upper()}",
                "store_id": store_id,
                "product_id": product_id,
                "quantity": quantity,
                "reason": reason,
                "damage_origin": damage_origin,
                "status": "sent_to_admin",
                "notes": note,
                "created_by": current_user_id,
                "created_at": now_iso,
                "updated_at": now_iso,
            }

            try:
                supabase.table("store_damage_returns").insert(row).execute()
                stock_ok = update_both_inventory_and_product_stock(
                    store_id=store_id,
                    product_id=product_id,
                    quantity_sold=quantity,
                )
                if not stock_ok:
                    raise RuntimeError("Failed to reduce stock for damaged return")

                supabase.table("damaged_inventory_events").insert(
                    {
                        "id": f"DMG-{uuid.uuid4().hex[:12].upper()}",
                        "store_id": store_id,
                        "product_id": product_id,
                        "quantity": quantity,
                        "source_type": "store_damage_return",
                        "source_id": row["id"],
                        "reason": reason,
                        "status": "reported",
                        "reported_by": current_user_id,
                        "created_at": now_iso,
                        "updated_at": now_iso,
                    }
                ).execute()
                created_rows.append(row)
            except Exception as cloud_error:
                # Offline fallback: local write + queue
                rows = read_json_file(STORE_DAMAGE_RETURNS_FILE, [])
                rows.append(row)
                write_json_file(STORE_DAMAGE_RETURNS_FILE, rows)
                _apply_local_stock_reduction(store_id, product_id, quantity)
                queue_info = enqueue_damage_return_create(current_user_id, row)
                row["queued"] = True
                row["queue_id"] = queue_info["queue_id"]
                row["cloud_error"] = str(cloud_error)
                created_rows.append(row)

        if not created_rows:
            return jsonify({"message": "No valid items to submit"}), 400

        was_queued = any(r.get("queued") for r in created_rows)
        return jsonify({
            "message": "Damage return submitted",
            "count": len(created_rows),
            "queued": was_queued,
            "rows": created_rows,
        }), 202 if was_queued else 201
    except Exception as e:
        app.logger.error(f"❌ Error creating store damage return: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500
