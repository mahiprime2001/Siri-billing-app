from flask import Blueprint, jsonify, current_app as app

from auth.auth import token_required
from data_access.data_access import get_customers_data

customer_bp = Blueprint('customer_bp', __name__)

@customer_bp.route('/customers', methods=['GET'])
@token_required
def get_customers():
    """Get all customers"""
    try:
        customers = get_customers_data()
        return jsonify(customers), 200
    except Exception as e:
        app.logger.error(f"Error getting customers: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500
