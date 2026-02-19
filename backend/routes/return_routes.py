from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client
from datetime import datetime, timezone
import uuid
import traceback

return_bp = Blueprint('return', __name__)


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
            return_amount = float(ret.get('return_amount', 0) or 0)
            original_qty = int(ret.get('original_quantity', 0) or 0)
            return_qty = int(ret.get('return_quantity', 0) or 0)
            
            transformed_returns.append({
                **ret,
                'product_name': product_data.get('name', 'Unknown Product'),
                'customer_name': customer_data.get('name', 'Walk-in Customer'),
                # Normalized phone key expected by frontend
                'customer_phone_number': customer_data.get('phone', '') or customer_data.get('phone_number', ''),
                'customer_phone': customer_data.get('phone', ''),
                'return_amount': return_amount,
                'original_quantity': original_qty,
                'return_quantity': return_qty,
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
        search_type = data.get('searchType', 'customer')
        store_id = data.get('storeId') or data.get('store_id')
        
        app.logger.info(f"🔍 User {current_user_id} searching bills: {query} ({search_type}) store={store_id}")
        
        if not query:
            return jsonify([]), 200
        
        supabase = get_supabase_client()
        
        # ✅ Search bills with JOIN to get customer data
        if search_type == 'customer':
            customer_response = supabase.table('customers').select('id').ilike('name', f'%{query}%').execute()
            if customer_response.data:
                customer_ids = [c['id'] for c in customer_response.data]
                response = supabase.table('bills').select(
                    '*, customers(id, name, phone)'
                ).in_('customerid', customer_ids)
                if store_id:
                    response = response.eq('storeid', store_id)
                response = response.execute()
            else:
                return jsonify([]), 200
                
        elif search_type == 'phone':
            customer_response = supabase.table('customers').select('id').ilike('phone', f'%{query}%').execute()
            if customer_response.data:
                customer_ids = [c['id'] for c in customer_response.data]
                response = supabase.table('bills').select(
                    '*, customers(id, name, phone)'
                ).in_('customerid', customer_ids)
                if store_id:
                    response = response.eq('storeid', store_id)
                response = response.execute()
            else:
                return jsonify([]), 200
                
        elif search_type == 'invoice':
            response = supabase.table('bills').select(
                '*, customers(id, name, phone)'
            ).ilike('id', f'%{query}%')
            if store_id:
                response = response.eq('storeid', store_id)
            response = response.execute()
        else:
            return jsonify({"message": "Invalid search type"}), 400
        
        bills = response.data if response.data else []
        
        # ✅ Transform bills to include items with product names via JOIN
        transformed_bills = []
        for bill in bills:
            # Get bill items with product details via JOIN
            bill_items_response = supabase.table('billitems').select(
                '*, products(id, name, selling_price)'
            ).eq('billid', bill['id']).order('id').execute()
            
            bill_items = bill_items_response.data if bill_items_response.data else []
            
            customer_data = bill.get('customers') or {}
            
            transformed_bills.append({
                'id': bill['id'],
                'customerId': bill.get('customerid', ''),
                'customerName': customer_data.get('name', 'Walk-in Customer'),
                'customerPhone': customer_data.get('phone', ''),
                'paymentMethod': bill.get('paymentmethod', 'cash'),
                'storeId': bill.get('storeid', None),
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
        created_by = data.get('createdBy', 'Unknown')
        
        app.logger.info(f"📦 User {current_user_id} submitting return with {len(selected_items)} items")
        
        if not selected_items or not return_reason:
            return jsonify({"message": "Missing required fields"}), 400
        
        supabase = get_supabase_client()
        created_returns = []
        bill_cache = {}

        def get_bill_with_items(bill_id: str):
            """Fetch bill and items once and cache for reuse."""
            if bill_id in bill_cache:
                return bill_cache[bill_id]

            bill_response = supabase.table('bills').select('id, storeid, customerid').eq('id', bill_id).limit(1).execute()
            bill_data = bill_response.data[0] if bill_response.data else None
            if not bill_data:
                return None

            items_response = supabase.table('billitems').select('productid, quantity, price, total').eq('billid', bill_id).order('id').execute()
            bill_cache[bill_id] = {
                **bill_data,
                'items': items_response.data or []
            }
            return bill_cache[bill_id]
        
        # Create return for each selected item
        for selected_item in selected_items:
            # Parse item ID (format: billId-itemIndex)
            item_id = selected_item['id']
            last_hyphen = item_id.rfind('-')
            bill_id = item_id[:last_hyphen]
            item_index = int(item_id[last_hyphen + 1:])
            
            # Find the bill and item from cached Supabase data
            bill = get_bill_with_items(bill_id)
            
            if not bill or item_index >= len(bill['items']):
                app.logger.warning(f"⚠️ Bill or item not found: {bill_id}, index {item_index}")
                return jsonify({"message": "Bill or item not found", "bill_id": bill_id, "item_index": item_index}), 404
            
            item = bill['items'][item_index]
            return_quantity = int(selected_item.get('quantity', 1))
            original_quantity = int(item.get('quantity', 0))
            unit_price = float(item.get('price', 0))
            product_id = item.get('productid') or item.get('productId')
            customer_id = bill.get('customerid', None)
            store_id = bill.get('storeid', None)

            if return_quantity < 1 or return_quantity > max(original_quantity, 0):
                return jsonify({
                    "message": "Invalid return quantity",
                    "bill_id": bill_id,
                    "product_id": product_id,
                    "allowed_max": original_quantity
                }), 400
            
            return_id = f"RET-{uuid.uuid4().hex[:12].upper()}"
            
            # ✅ Only store IDs - no product_name needed
            return_data = {
                'return_id': return_id,
                'product_id': product_id,
                'customer_id': customer_id,
                'store_id': store_id,
                'message': return_reason,
                'refund_method': refund_method,
                'bill_id': bill_id,
                'original_quantity': original_quantity,
                'return_quantity': return_quantity,
                'return_amount': unit_price * return_quantity,
                'status': 'pending',
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
        store_id = request.args.get('store_id')
        
        supabase = get_supabase_client()
        query = supabase.table('returns').select('return_id', count='exact').eq('status', 'pending')
        if store_id:
            query = query.eq('store_id', store_id)
        response = query.execute()
        
        count = response.count if hasattr(response, 'count') else len(response.data or [])
        
        app.logger.debug(f"📊 User {current_user_id} fetched pending returns count: {count} store={store_id}")
        
        return jsonify({"count": count}), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching pending returns count: {str(e)}")
        return jsonify({"message": "An error occurred"}), 500
