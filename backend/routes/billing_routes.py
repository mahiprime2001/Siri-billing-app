from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client
from datetime import datetime, timezone
import uuid
import traceback

# Import stock update function
from data_access.data_access import update_both_inventory_and_product_stock

# ✅ Default Walk-in Customer ID
DEFAULT_WALKIN_CUSTOMER_ID = "CUST-1754821420265"

billing_bp = Blueprint('billing', __name__)


@billing_bp.route('/bills', methods=['GET'])
@require_auth
def get_bills():
    """Get all bills with optional filtering"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching bills")
        
        store_id = request.args.get('store_id')
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        limit = request.args.get('limit', 100, type=int)
        
        supabase = get_supabase_client()
        
        # ✅ Include customer and store details via JOIN
        query = supabase.table('bills').select(
            '*, customers(name, phone, email, address), stores(name, address, phone)'
        )
        
        if store_id:
            query = query.eq('storeid', store_id)
        if start_date:
            query = query.gte('created_at', start_date)
        if end_date:
            query = query.lte('created_at', end_date)
        
        response = query.limit(limit).order('created_at', desc=True).execute()
        bills = response.data if response.data else []
        
        app.logger.info(f"✅ Fetched {len(bills)} bills")
        return jsonify(bills), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching bills: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@billing_bp.route('/bills/<bill_id>', methods=['GET'])
@require_auth
def get_bill(bill_id):
    """Get a specific bill by ID with store and customer details"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching bill {bill_id}")
        
        supabase = get_supabase_client()
        
        # ✅ Use JOIN to get store and customer details
        response = supabase.table('bills') \
            .select('*, stores(name, address, phone), customers(name, phone, email, address)') \
            .eq('id', bill_id) \
            .execute()
        
        if not response.data or len(response.data) == 0:
            return jsonify({"message": "Bill not found"}), 404
        
        bill = response.data[0]
        app.logger.info(f"✅ Bill found: {bill_id}")
        return jsonify(bill), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching bill {bill_id}: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@billing_bp.route('/bills', methods=['POST'])
@require_auth
def create_bill():
    """Create a new bill and update inventory"""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json()
        
        app.logger.info(f"💰 User {current_user_id} creating new bill")
        app.logger.info(f"📥 Received data: {data}")
        
        # Validate required fields
        required_fields = ['store_id', 'items', 'total_amount']
        if not all(field in data for field in required_fields):
            missing = [f for f in required_fields if f not in data]
            return jsonify({"message": f"Missing: {missing}", "error": f"Missing required fields"}), 400
        
        store_id = data['store_id']
        items = data['items']
        
        if not items or len(items) == 0:
            return jsonify({"message": "No items", "error": "Items list is empty"}), 400
        
        # Generate bill ID
        bill_id = f"BILL-{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).isoformat()
        
        # ✅ Use default Walk-in Customer ID if no customer provided
        customer_id = data.get('customer_id') or DEFAULT_WALKIN_CUSTOMER_ID
        
        # ✅ Simplified bill_data - ONLY IDs (no denormalized data)
        bill_data = {
            'id': bill_id,
            'storeid': store_id,
            'customerid': customer_id,  # ✅ Defaults to Walk-in Customer
            'userid': current_user_id,
            'subtotal': data.get('subtotal', data['total_amount']),
            'discount_percentage': data.get('discount_percentage', 0),
            'discount_amount': data.get('discount_amount', 0),
            'total': data['total_amount'],
            'paymentmethod': data.get('payment_method', 'cash'),
            'timestamp': now,
            'status': 'completed',
            'createdby': current_user_id,
            'created_at': now,
            'updated_at': now
        }
        
        app.logger.info(f"📤 Inserting bill: {bill_id} for customer: {customer_id}")
        
        supabase = get_supabase_client()
        
        # Create the bill record
        response = supabase.table('bills').insert(bill_data).execute()
        
        if not response.data or len(response.data) == 0:
            app.logger.error("❌ Bill insert failed - empty response")
            return jsonify({"message": "Failed to create bill", "error": "Database insert failed"}), 500
        
        created_bill = response.data[0]
        app.logger.info(f"✅ Bill created: {bill_id}")
        
        # Process each item and create bill items + update stock
        bill_items_created = []
        stock_update_errors = []
        
        for item in items:
            product_id = item.get('product_id')
            quantity = item.get('quantity', 1)
            unit_price = item.get('unit_price', 0)
            item_total = item.get('item_total', unit_price * quantity)
            
            if not product_id:
                app.logger.warning("⚠️ Skipping item with no product_id")
                continue
            
            # ✅ Clean billitems data - no tax/gst fields
            bill_item_data = {
                "billid": bill_id,
                "productid": product_id,
                "quantity": quantity,
                "price": unit_price,
                "total": item_total,
                "created_at": now,
                "updated_at": now
            }
            
            try:
                # Save bill item
                item_response = supabase.table('billitems').insert(bill_item_data).execute()
                
                if item_response.data:
                    bill_items_created.append(product_id)
                    app.logger.info(f"✅ Bill item created for {product_id}")
                else:
                    app.logger.error(f"❌ Failed to create bill item for {product_id}")
                    
            except Exception as item_error:
                app.logger.error(f"❌ Error creating bill item: {item_error}")
                app.logger.error(traceback.format_exc())
            
            # ✅ UPDATE STOCK IN BOTH TABLES
            try:
                stock_updated = update_both_inventory_and_product_stock(
                    store_id=store_id,
                    product_id=product_id,
                    quantity_sold=quantity
                )
                
                if not stock_updated:
                    stock_update_errors.append(product_id)
                    app.logger.error(f"❌ Failed to update stock for {product_id}")
                else:
                    app.logger.info(f"✅ Stock updated for {product_id}")
                    
            except Exception as stock_error:
                stock_update_errors.append(product_id)
                app.logger.error(f"❌ Error updating stock: {stock_error}")
                app.logger.error(traceback.format_exc())
        
        # Prepare response
        response_data = {
            "message": "Bill created successfully",
            "bill_id": bill_id,
            "bill": created_bill,
            "items_created": len(bill_items_created),
            "total_amount": data['total_amount']
        }
        
        if stock_update_errors:
            response_data["stock_update_errors"] = stock_update_errors
            response_data["warning"] = f"Stock update failed for {len(stock_update_errors)} products"
        
        app.logger.info(f"✅ Bill {bill_id} completed with {len(bill_items_created)} items")
        
        return jsonify(response_data), 201
        
    except Exception as e:
        app.logger.error(f"❌ Error creating bill: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@billing_bp.route('/bills/<bill_id>', methods=['PUT'])
@require_auth
def update_bill(bill_id):
    """Update a bill"""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json()
        
        app.logger.info(f"User {current_user_id} updating bill {bill_id}")
        
        # Only allow updating certain fields
        allowed_fields = ['status', 'paymentmethod']
        update_data = {k: v for k, v in data.items() if k in allowed_fields}
        
        if not update_data:
            return jsonify({"message": "No valid fields to update"}), 400
        
        update_data['updated_at'] = datetime.now(timezone.utc).isoformat()
        
        supabase = get_supabase_client()
        response = supabase.table('bills').update(update_data).eq('id', bill_id).execute()
        
        if not response.data or len(response.data) == 0:
            return jsonify({"message": "Bill not found"}), 404
        
        updated_bill = response.data[0]
        app.logger.info(f"✅ Updated bill: {bill_id}")
        
        return jsonify(updated_bill), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error updating bill {bill_id}: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@billing_bp.route('/bills/<bill_id>', methods=['DELETE'])
@require_auth
def delete_bill(bill_id):
    """Delete a bill (soft delete by marking as cancelled)"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} deleting bill {bill_id}")
        
        supabase = get_supabase_client()
        
        # Soft delete - mark as cancelled
        update_data = {
            'status': 'cancelled',
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        response = supabase.table('bills').update(update_data).eq('id', bill_id).execute()
        
        if not response.data or len(response.data) == 0:
            return jsonify({"message": "Bill not found"}), 404
        
        app.logger.info(f"✅ Bill cancelled: {bill_id}")
        return jsonify({"message": "Bill cancelled successfully"}), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error deleting bill {bill_id}: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@billing_bp.route('/bills/stats', methods=['GET'])
@require_auth
def get_billing_stats():
    """Get billing statistics"""
    try:
        current_user_id = get_jwt_identity()
        store_id = request.args.get('store_id')
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        
        supabase = get_supabase_client()
        query = supabase.table('bills').select('total, created_at, status')
        
        if store_id:
            query = query.eq('storeid', store_id)
        if start_date:
            query = query.gte('created_at', start_date)
        if end_date:
            query = query.lte('created_at', end_date)
        
        # Only include completed bills in stats
        query = query.eq('status', 'completed')
        
        response = query.execute()
        bills = response.data if response.data else []
        
        total_sales = sum(bill['total'] for bill in bills)
        total_bills = len(bills)
        avg_bill_amount = total_sales / total_bills if total_bills > 0 else 0
        
        stats = {
            'total_sales': total_sales,
            'total_bills': total_bills,
            'average_bill_amount': avg_bill_amount
        }
        
        app.logger.info(f"User {current_user_id} fetched billing stats: {stats}")
        return jsonify(stats), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching billing stats: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@billing_bp.route('/bills/<bill_id>/items', methods=['GET'])
@require_auth
def get_bill_items(bill_id):
    """Get all items for a specific bill"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching items for bill {bill_id}")
        
        supabase = get_supabase_client()
        
        # Get bill items with product details
        response = supabase.table('billitems') \
            .select('*, products(name, barcode, price)') \
            .eq('billid', bill_id) \
            .execute()
        
        items = response.data if response.data else []
        
        app.logger.info(f"✅ Fetched {len(items)} items for bill {bill_id}")
        return jsonify(items), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching bill items: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500
