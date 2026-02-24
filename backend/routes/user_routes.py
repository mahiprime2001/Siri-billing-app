from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client
from datetime import datetime, timezone
from helpers.utils import read_json_file
from config.config import USERS_FILE

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
        cached = read_json_file(USERS_FILE, [])
        cached = [u for u in cached if u.get("role") != "super_admin"]
        app.logger.warning(f"Returning {len(cached)} cached users as fallback")
        return jsonify(cached), 200


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
        cached = read_json_file(USERS_FILE, [])
        user = next((u for u in cached if str(u.get("id")) == str(user_id)), None)
        if user and user.get("role") == "super_admin":
            user = None
        if not user:
            return jsonify({"message": "User not found"}), 404
        return jsonify(user), 200


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
        base_version = data.get("baseVersion") or data.get("base_version")
        base_updated_at = data.get("baseUpdatedAt") or data.get("base_updated_at") or data.get("baseupdatedat")
        
        # ✅ SECURITY: Don't allow changing role to super_admin
        if 'role' in update_data and update_data['role'] == 'super_admin':
            app.logger.warning(f"⚠️ User {current_user_id} attempted to set role to super_admin")
            return jsonify({"message": "Cannot set role to super_admin"}), 403
        
        if not update_data:
            return jsonify({"message": "No valid fields to update"}), 400

        update_data['updatedat'] = datetime.now(timezone.utc).isoformat()

        # Conflict-safe update: require base marker to avoid blind overwrite.
        query = supabase.table('users').update(update_data).eq('id', user_id)
        if base_version is not None:
            try:
                base_version = int(base_version)
                query = query.eq('version', base_version)
                update_data['version'] = base_version + 1
            except (TypeError, ValueError):
                return jsonify({"message": "Invalid baseVersion"}), 400
        elif base_updated_at:
            query = query.eq('updatedat', base_updated_at)
        else:
            latest = supabase.table('users').select('id, updatedat, version').eq('id', user_id).limit(1).execute()
            return jsonify({
                "message": "Conflict check required. Send baseVersion or baseUpdatedAt.",
                "latest": latest.data[0] if latest.data else None,
            }), 409

        response = query.execute()

        if not response.data or len(response.data) == 0:
            latest = supabase.table('users').select('*').eq('id', user_id).limit(1).execute()
            return jsonify({
                "message": "Update conflict: record changed in another app/session.",
                "latest": latest.data[0] if latest.data else None,
            }), 409
        
        updated_user = response.data[0]
        app.logger.info(f"✅ Updated user: {updated_user['email']}")
        return jsonify(updated_user), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error updating user {user_id}: {str(e)}")
        return jsonify({"message": "An error occurred while updating user"}), 500
