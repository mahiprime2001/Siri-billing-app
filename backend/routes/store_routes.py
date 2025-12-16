from flask import Blueprint, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client

store_bp = Blueprint('store', __name__)

@store_bp.route('/stores', methods=['GET'])
@require_auth
def get_stores():
    """Get all stores"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching stores")
        
        supabase = get_supabase_client()
        response = supabase.table('stores').select('*').execute()
        
        stores = response.data if response.data else []
        
        app.logger.info(f"✅ Fetched {len(stores)} stores")
        return jsonify({"stores": stores}), 200  # ✅ Wrapped in object
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching stores: {str(e)}")
        return jsonify({"message": "An error occurred"}), 500


@store_bp.route('/user-stores', methods=['GET'])
@require_auth
def get_user_stores():
    """Get user-store associations for the current user"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"📍 User {current_user_id} fetching their user-stores")
        
        supabase = get_supabase_client()
        
        # ✅ Query userstores table with correct column names
        response = supabase.table('userstores') \
            .select('userId, storeId, created_at, updated_at') \
            .eq('userId', current_user_id) \
            .execute()
        
        user_stores = response.data if response.data else []
        
        app.logger.info(f"✅ Found {len(user_stores)} user-store associations for user {current_user_id}")
        app.logger.debug(f"User-stores data: {user_stores}")
        
        return jsonify(user_stores), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching user stores: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred"}), 500


@store_bp.route('/stores/current', methods=['GET'])
@require_auth
def get_current_user_store():
    """Get the store assigned to the current user (with full store details)"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"📍 User {current_user_id} fetching their assigned store")
        
        supabase = get_supabase_client()
        
        # Get user's store ID
        user_stores_response = supabase.table('userstores') \
            .select('storeId') \
            .eq('userId', current_user_id) \
            .execute()
        
        if not user_stores_response.data or len(user_stores_response.data) == 0:
            app.logger.warning(f"⚠️ No store assigned to user {current_user_id}")
            return jsonify({"message": "No store assigned to this user"}), 404
        
        store_id = user_stores_response.data[0]['storeId']
        app.logger.info(f"📍 User {current_user_id} is assigned to store {store_id}")
        
        # Get store details
        store_response = supabase.table('stores') \
            .select('*') \
            .eq('id', store_id) \
            .execute()
        
        if not store_response.data or len(store_response.data) == 0:
            app.logger.error(f"❌ Store {store_id} not found in database")
            return jsonify({"message": "Store not found"}), 404
        
        store = store_response.data[0]
        app.logger.info(f"✅ Found store: {store['name']} (ID: {store['id']})")
        
        return jsonify(store), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching current user store: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred"}), 500
