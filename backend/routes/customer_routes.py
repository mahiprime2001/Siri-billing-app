from flask import Blueprint, jsonify, request, current_app as app
from auth.auth import session_required
from data_access.data_access import get_customers_data
from utils.connection_pool import get_supabase_client
from data_access.supabase_data_access import sync_to_supabase_immediately
from supabase import Client
import uuid
from datetime import datetime

customer_bp = Blueprint('customer_bp', __name__)

@customer_bp.route('/customers', methods=['GET'])
# @session_required  # Commented for autocomplete
def get_customers():
    """Get all customers"""
    try:
        customers = get_customers_data()
        if not isinstance(customers, list):
            app.logger.error(f"get_customers_data returned non-list type: {type(customers)}")
            customers = []
        return jsonify(customers), 200
    except Exception as e:
        app.logger.error(f"Error getting customers: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500


@customer_bp.route('/customers', methods=['POST'])
@session_required
def create_or_update_customer():
    """Create a new customer or update existing one"""
    try:
        data = request.json
        
        # Validate required fields
        if not data.get('name') or not data.get('phone'):
            return jsonify({"error": "Customer name and phone are required"}), 400
        
        supabase: Client = get_supabase_client()
        if not supabase:
            return jsonify({"error": "Supabase client not available"}), 500
        
        try:
            # Check if customer already exists by phone
            response = supabase.from_("customers").select("*").eq("phone", data.get('phone')).execute()
            existing_customer = response.data[0] if response.data else None
            
            customer_id = None
            if existing_customer:
                # Update existing customer
                customer_id = existing_customer['id']
                update_data = {
                    "name": data.get('name'),
                    "email": data.get('email', ''),
                    "address": data.get('address', ''),
                    "updatedAt": datetime.now().isoformat()
                }
                
                response = supabase.from_("customers").update(update_data).eq("id", customer_id).execute()
                
                if response.data:
                    app.logger.info(f"Updated customer: {customer_id}")
                    # Also sync to JSON via data_access
                    sync_to_supabase_immediately('Customers', {**update_data, 'id': customer_id}, "UPDATE")
                    return jsonify({
                        "message": "Customer updated",
                        "customer": {
                            "id": customer_id,
                            "name": data.get('name'),
                            "phone": data.get('phone'),
                            "email": data.get('email', ''),
                            "address": data.get('address', '')
                        }
                    }), 200
                else:
                    app.logger.error(f"Failed to update customer {customer_id}: {response.status_code} {response.json()}")
                    return jsonify({"error": "Failed to update customer"}), 500
            else:
                # Create new customer
                customer_id = f"CUST-{uuid.uuid4().hex[:12]}"
                now = datetime.now().isoformat()
                
                insert_data = {
                    "id": customer_id,
                    "name": data.get('name'),
                    "phone": data.get('phone'),
                    "email": data.get('email', ''),
                    "address": data.get('address', ''),
                    "createdAt": now,
                    "updatedAt": now
                }
                
                response = supabase.from_("customers").insert(insert_data).execute()
                
        except Exception as e:
            app.logger.error(f"Error in Supabase operations for customer: {e}\n{traceback.format_exc()}")
            return jsonify({"error": "Internal server error", "details": str(e)}), 500
            
    except Exception as e:
        app.logger.error(f"Error creating/updating customer: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500


@customer_bp.route('/customers/<customer_id>', methods=['GET'])
@session_required
def get_customer_by_id(customer_id):
    """Get customer by ID"""
    try:
        supabase: Client = get_supabase_client()
        if not supabase:
            return jsonify({"error": "Supabase client not available"}), 500
        
        try:
            response = supabase.from_("customers").select("*").eq("id", customer_id).execute()
            customer = response.data[0] if response.data else None
            
            if customer:
                return jsonify(customer), 200
            else:
                return jsonify({"error": "Customer not found"}), 404
                
        except Exception as e:
            app.logger.error(f"Error in Supabase operations for customer {customer_id}: {e}\n{traceback.format_exc()}")
            return jsonify({"error": "Internal server error", "details": str(e)}), 500
            
    except Exception as e:
        app.logger.error(f"Error getting customer: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500
