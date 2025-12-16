from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client

user_bp = Blueprint('user', __name__)

@user_bp.route('/users', methods=['GET'])
@require_auth
def get_users():
    """Get all users (excluding super_admin)"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching all users")
        
        supabase = get_supabase_client()
        
        # ✅ FIXED: Exclude super_admin users from query
        response = supabase.table('users') \
            .select('id, email, name, role, createdat, updatedat') \
            .neq('role', 'super_admin') \
            .execute()
        
        users = response.data if response.data else []
        
        app.logger.info(f"✅ Fetched {len(users)} users (super_admin excluded)")
        return jsonify(users), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching users: {str(e)}")
        return jsonify({"message": "An error occurred while fetching users"}), 500


@user_bp.route('/users/<user_id>', methods=['GET'])
@require_auth
def get_user(user_id):
    """Get a specific user by ID"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching user {user_id}")
        
        supabase = get_supabase_client()
        
        # Fetch user
        response = supabase.table('users') \
            .select('id, email, name, role, createdat, updatedat') \
            .eq('id', user_id) \
            .execute()
        
        if not response.data or len(response.data) == 0:
            return jsonify({"message": "User not found"}), 404
        
        user = response.data[0]
        
        # ✅ SECURITY: Don't allow fetching super_admin user details
        if user.get('role') == 'super_admin':
            app.logger.warning(f"⚠️ User {current_user_id} attempted to fetch super_admin user {user_id}")
            return jsonify({"message": "User not found"}), 404
        
        app.logger.info(f"✅ Fetched user: {user['email']}")
        return jsonify(user), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching user {user_id}: {str(e)}")
        return jsonify({"message": "An error occurred while fetching user"}), 500


@user_bp.route('/users/<user_id>', methods=['PUT'])
@require_auth
def update_user(user_id):
    """Update a user"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} updating user {user_id}")
        
        data = request.get_json()
        
        supabase = get_supabase_client()
        
        # ✅ SECURITY: Check if user being updated is super_admin
        user_check = supabase.table('users').select('role').eq('id', user_id).execute()
        
        if not user_check.data or len(user_check.data) == 0:
            return jsonify({"message": "User not found"}), 404
        
        if user_check.data[0].get('role') == 'super_admin':
            app.logger.warning(f"⚠️ User {current_user_id} attempted to update super_admin user {user_id}")
            return jsonify({"message": "Cannot modify super admin user"}), 403
        
        # Only allow updating certain fields
        allowed_fields = ['name', 'role']
        update_data = {k: v for k, v in data.items() if k in allowed_fields}
        
        # ✅ SECURITY: Don't allow changing role to super_admin
        if 'role' in update_data and update_data['role'] == 'super_admin':
            app.logger.warning(f"⚠️ User {current_user_id} attempted to set role to super_admin")
            return jsonify({"message": "Cannot set role to super_admin"}), 403
        
        if not update_data:
            return jsonify({"message": "No valid fields to update"}), 400
        
        # Update user
        response = supabase.table('users').update(update_data).eq('id', user_id).execute()
        
        if not response.data or len(response.data) == 0:
            return jsonify({"message": "User not found"}), 404
        
        updated_user = response.data[0]
        app.logger.info(f"✅ Updated user: {updated_user['email']}")
        return jsonify(updated_user), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error updating user {user_id}: {str(e)}")
        return jsonify({"message": "An error occurred while updating user"}), 500
