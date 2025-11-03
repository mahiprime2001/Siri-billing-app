from flask import Blueprint, jsonify, current_app as app

from auth.auth import token_required
from data_access.data_access import get_stores_data

store_bp = Blueprint('store_bp', __name__)

@store_bp.route('/stores', methods=['GET'])
@token_required
def get_stores():
    """Get all stores"""
    try:
        stores = get_stores_data()
        return jsonify({"stores": stores}), 200
    except Exception as e:
        app.logger.error(f"Error getting stores: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500
