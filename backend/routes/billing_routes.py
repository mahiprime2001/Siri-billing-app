from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client
from datetime import datetime, timezone
import traceback

from services.billing_service import create_bill_transaction
from utils.offline_bill_queue import enqueue_bill_create

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
    """Create a new bill. If Supabase is unavailable, queue it for later sync."""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json() or {}
        app.logger.info(f"💰 User {current_user_id} creating new bill")

        try:
            response_data = create_bill_transaction(current_user_id=current_user_id, data=data)
            app.logger.info(f"✅ Bill {response_data.get('bill_id')} completed")
            return jsonify(response_data), 201
        except ValueError as e:
            return jsonify({"message": str(e)}), 400
        except Exception as e:
            app.logger.error(f"❌ Immediate bill create failed; queueing offline: {e}")
            app.logger.error(traceback.format_exc())

            queue_result = enqueue_bill_create(current_user_id=current_user_id, bill_payload=data)
            return jsonify({
                "message": "System offline. Invoice queued and will sync automatically when internet returns.",
                "queued": True,
                "queue_id": queue_result["queue_id"],
                "bill_id": queue_result["bill_id"],
            }), 202

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
            .select('*, products(name, barcode, price, selling_price, hsn_code_id, hsn_codes(hsn_code))') \
            .eq('billid', bill_id) \
            .execute()
        
        items = response.data if response.data else []
        enriched_items = []
        for item in items:
            product = item.get('products') or {}
            hsn_ref = product.get('hsn_codes')
            if isinstance(hsn_ref, list):
                hsn_ref = hsn_ref[0] if hsn_ref else None
            hsn_code = None
            if isinstance(hsn_ref, dict):
                hsn_code = hsn_ref.get('hsn_code')
            if not hsn_code:
                hsn_code = product.get('hsn_code')
            if hsn_code:
                item['hsn_code'] = hsn_code
                item['hsnCode'] = hsn_code
            enriched_items.append(item)
        
        app.logger.info(f"✅ Fetched {len(enriched_items)} items for bill {bill_id}")
        return jsonify(enriched_items), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching bill items: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500
