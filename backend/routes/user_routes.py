from flask import Blueprint, jsonify, make_response, request, current_app as app

from auth.auth import session_required # Changed from token_required
from data_access.data_access import get_users_data
from data_access.mysql_data_access import get_mysql_data

user_bp = Blueprint('user_bp', __name__)

@user_bp.route('/users', methods=['GET', 'OPTIONS'])
@session_required
def get_users():
    """Get all users"""
    if request.method == 'OPTIONS':
        response = make_response()
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add("Access-Control-Allow-Methods", "GET, OPTIONS")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        return response, 200
    
    try:
        users = get_users_data()
        # Remove passwords from response
        safe_users = [{k: v for k, v in user.items() if k != 'password'} for user in users]
        return jsonify(safe_users), 200
    except Exception as e:
        app.logger.error(f"Error getting users: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@user_bp.route('/user-stores', methods=['GET', 'OPTIONS'])
@session_required
def get_user_stores():
    """Get user-store associations"""
    if request.method == 'OPTIONS':
        response = make_response()
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add("Access-Control-Allow-Methods", "GET, OPTIONS")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        return response, 200
    
    try:
        # Get user-store associations from MySQL
        user_stores = get_mysql_data('UserStores')
        if user_stores is None:
            user_stores = []
        
        return jsonify(user_stores), 200
    except Exception as e:
        app.logger.error(f"Error getting user-stores: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@user_bp.route('/user-stores/<user_id>', methods=['GET', 'OPTIONS'])
@session_required
def get_user_stores_by_id(user_id):
    """Get stores for a specific user"""
    if request.method == 'OPTIONS':
        response = make_response()
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add("Access-Control-Allow-Methods", "GET, OPTIONS")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        return response, 200
    
    try:
        # Get user-store associations for specific user
        user_stores = get_mysql_data('UserStores', 'userId = %s', (user_id,))
        if user_stores is None:
            user_stores = []
        
        return jsonify(user_stores), 200
    except Exception as e:
        app.logger.error(f"Error getting user-stores for user {user_id}: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500
