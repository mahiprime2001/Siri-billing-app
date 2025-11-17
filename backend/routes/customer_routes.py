from flask import Blueprint, jsonify, request, current_app as app
from auth.auth import session_required
from data_access.data_access import get_customers_data
from utils.connection_pool import get_connection
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
        
        connection = get_connection()
        if not connection:
            return jsonify({"error": "Database connection failed"}), 500
        
        cursor = connection.cursor(dictionary=True)
        
        try:
            # Check if customer already exists by phone
            cursor.execute(
                "SELECT * FROM Customers WHERE phone = %s",
                (data.get('phone'),)
            )
            existing_customer = cursor.fetchone()
            
            if existing_customer:
                # Update existing customer
                cursor.execute("""
                    UPDATE Customers 
                    SET name = %s, email = %s, address = %s, updatedAt = %s
                    WHERE phone = %s
                """, (
                    data.get('name'),
                    data.get('email', ''),
                    data.get('address', ''),
                    datetime.now(),
                    data.get('phone')
                ))
                connection.commit()
                
                app.logger.info(f"Updated customer: {existing_customer['id']}")
                return jsonify({
                    "message": "Customer updated",
                    "customer": {
                        "id": existing_customer['id'],
                        "name": data.get('name'),
                        "phone": data.get('phone'),
                        "email": data.get('email', ''),
                        "address": data.get('address', '')
                    }
                }), 200
            else:
                # Create new customer
                customer_id = f"CUST-{uuid.uuid4().hex[:12]}"
                now = datetime.now()
                
                cursor.execute("""
                    INSERT INTO Customers (id, name, phone, email, address, createdAt, updatedAt)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                """, (
                    customer_id,
                    data.get('name'),
                    data.get('phone'),
                    data.get('email', ''),
                    data.get('address', ''),
                    now,
                    now
                ))
                connection.commit()
                
                app.logger.info(f"Created new customer: {customer_id}")
                return jsonify({
                    "message": "Customer created",
                    "customer": {
                        "id": customer_id,
                        "name": data.get('name'),
                        "phone": data.get('phone'),
                        "email": data.get('email', ''),
                        "address": data.get('address', '')
                    }
                }), 201
                
        finally:
            cursor.close()
            connection.close()
            
    except Exception as e:
        app.logger.error(f"Error creating/updating customer: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500


@customer_bp.route('/customers/<customer_id>', methods=['GET'])
@session_required
def get_customer_by_id(customer_id):
    """Get customer by ID"""
    try:
        connection = get_connection()
        if not connection:
            return jsonify({"error": "Database connection failed"}), 500
        
        cursor = connection.cursor(dictionary=True)
        
        try:
            cursor.execute("SELECT * FROM Customers WHERE id = %s", (customer_id,))
            customer = cursor.fetchone()
            
            if customer:
                return jsonify(customer), 200
            else:
                return jsonify({"error": "Customer not found"}), 404
                
        finally:
            cursor.close()
            connection.close()
            
    except Exception as e:
        app.logger.error(f"Error getting customer: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500
