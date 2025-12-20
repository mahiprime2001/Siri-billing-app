from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client
from datetime import datetime, timezone
import uuid
import traceback

customer_bp = Blueprint('customer', __name__)


@customer_bp.route('/customers', methods=['GET'])
@require_auth
def get_customers():
    """Get all customers"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"📋 User {current_user_id} fetching customers")
        
        search = request.args.get('search', '').strip()
        limit = request.args.get('limit', 100, type=int)
        
        supabase = get_supabase_client()
        query = supabase.table('customers').select('*')
        
        if search:
            query = query.or_(f'name.ilike.%{search}%,phone.ilike.%{search}%,email.ilike.%{search}%')
        
        # ✅ customers table uses 'createdat' (no underscore per schema)
        response = query.limit(limit).order('createdat', desc=True).execute()
        customers = response.data if response.data else []
        
        app.logger.info(f"✅ Fetched {len(customers)} customers")
        return jsonify(customers), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching customers: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@customer_bp.route('/customers/<customer_id>', methods=['GET'])
@require_auth
def get_customer(customer_id):
    """Get a specific customer by ID"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching customer {customer_id}")
        
        supabase = get_supabase_client()
        response = supabase.table('customers').select('*').eq('id', customer_id).execute()
        
        if not response.data or len(response.data) == 0:
            return jsonify({"message": "Customer not found"}), 404
        
        customer = response.data[0]
        app.logger.info(f"✅ Customer found: {customer_id}")
        return jsonify(customer), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching customer {customer_id}: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@customer_bp.route('/customers', methods=['POST'])
@require_auth
def create_customer():
    """Create a new customer"""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json()
        
        app.logger.info(f"👤 User {current_user_id} creating new customer")
        
        # More flexible validation
        if not data.get('name') and not data.get('phone'):
            return jsonify({"message": "Either customer name or phone is required"}), 400
        
        # Generate customer ID
        customer_id = f"CUST-{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).isoformat()
        
        # ✅ customers table uses 'createdat' and 'updatedat' (no underscores)
        customer_data = {
            'id': customer_id,
            'name': data.get('name', 'Walk-in Customer'),
            'phone': data.get('phone', ''),
            'email': data.get('email', ''),
            'address': data.get('address', ''),
            'createdat': now,
            'updatedat': now
        }
        
        supabase = get_supabase_client()
        response = supabase.table('customers').insert(customer_data).execute()
        
        if not response.data or len(response.data) == 0:
            return jsonify({"message": "Failed to create customer"}), 500
        
        created_customer = response.data[0]
        app.logger.info(f"✅ Created customer: {customer_id}")
        
        return jsonify(created_customer), 201
        
    except Exception as e:
        app.logger.error(f"❌ Error creating customer: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@customer_bp.route('/customers/<customer_id>', methods=['PUT'])
@require_auth
def update_customer(customer_id):
    """Update a customer"""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json()
        
        app.logger.info(f"User {current_user_id} updating customer {customer_id}")
        
        allowed_fields = ['name', 'phone', 'email', 'address']
        update_data = {k: v for k, v in data.items() if k in allowed_fields}
        
        if not update_data:
            return jsonify({"message": "No valid fields to update"}), 400
        
        # ✅ customers table uses 'updatedat' (no underscore)
        update_data['updatedat'] = datetime.now(timezone.utc).isoformat()
        
        supabase = get_supabase_client()
        response = supabase.table('customers').update(update_data).eq('id', customer_id).execute()
        
        if not response.data or len(response.data) == 0:
            return jsonify({"message": "Customer not found"}), 404
        
        updated_customer = response.data[0]
        app.logger.info(f"✅ Updated customer: {customer_id}")
        
        return jsonify(updated_customer), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error updating customer {customer_id}: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@customer_bp.route('/customers/<customer_id>', methods=['DELETE'])
@require_auth
def delete_customer(customer_id):
    """Delete a customer"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} deleting customer {customer_id}")
        
        supabase = get_supabase_client()
        response = supabase.table('customers').delete().eq('id', customer_id).execute()
        
        if not response.data or len(response.data) == 0:
            return jsonify({"message": "Customer not found"}), 404
        
        app.logger.info(f"✅ Deleted customer: {customer_id}")
        return jsonify({"message": "Customer deleted successfully"}), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error deleting customer {customer_id}: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500
