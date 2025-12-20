from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import (
    create_access_token, 
    jwt_required, 
    get_jwt,
    get_jwt_identity,
    set_access_cookies,
    unset_jwt_cookies
)
from datetime import datetime, timezone
from utils.connection_pool import get_supabase_client

auth_bp = Blueprint('auth', __name__)

@auth_bp.route('/login', methods=['POST'])
def login():
    """User login with JWT token generation"""
    try:
        data = request.get_json()
        email = data.get('email', '').strip().lower()
        password = data.get('password', '')
        
        app.logger.info(f"🔐 [BACKEND-LOGIN] Login attempt for email: {email}")
        app.logger.info(f"📍 [BACKEND-LOGIN] Request origin: {request.headers.get('Origin')}")
        
        if not email or not password:
            app.logger.warning(f"⚠️ [BACKEND-LOGIN] Missing email or password")
            return jsonify({"message": "Email and password required"}), 400
        
        # Get Supabase client
        supabase = get_supabase_client()
        
        # Query user from Supabase
        response = supabase.table('users').select('*').eq('email', email).execute()
        
        if not response.data or len(response.data) == 0:
            app.logger.warning(f"⚠️ [BACKEND-LOGIN] User not found: {email}")
            return jsonify({"message": "Invalid email or password"}), 401
        
        user = response.data[0]
        user_id = user['id']
        stored_password = user.get('password', '')  # Changed: using 'password' field
        user_name = user.get('name', 'Unknown')
        user_role = user.get('role', 'user')
        
        # Simple password comparison (no hashing)
        if password != stored_password:
            app.logger.warning(f"⚠️ [BACKEND-LOGIN] Invalid password for user: {email}")
            return jsonify({"message": "Invalid email or password"}), 401
        
        app.logger.info(f"✅ [BACKEND-LOGIN] User authenticated: {user_id}")
        app.logger.info(f"👤 [BACKEND-LOGIN] User name: {user_name}")
        app.logger.info(f"🎭 [BACKEND-LOGIN] User role: {user_role}")
        
        # Create JWT token with additional claims
        additional_claims = {
            "email": email,
            "name": user_name,
            "role": user_role
        }
        access_token = create_access_token(
            identity=user_id,
            additional_claims=additional_claims
        )
        
        app.logger.info(f"🎫 [BACKEND-LOGIN] JWT token created for user: {user_id}")
        
        # Create response
        response = jsonify({
            "auth_ok": True,
            "message": "Login successful",
            "user": {
                "id": user_id,
                "email": email,
                "name": user_name
            },
            "user_role": user_role
        })
        
        # Set JWT cookie
        set_access_cookies(response, access_token)
        
        app.logger.info(f"📤 [BACKEND-LOGIN] Sending response with JWT cookie")
        
        return response, 200
        
    except Exception as e:
        app.logger.error(f"❌ [BACKEND-LOGIN] Login error: {str(e)}")
        import traceback
        app.logger.error(f"📋 [BACKEND-LOGIN] Traceback: {traceback.format_exc()}")
        return jsonify({"message": "An error occurred during login"}), 500


@auth_bp.route('/logout', methods=['POST'])
@jwt_required()
def logout():
    """User logout - clears JWT cookie"""
    try:
        user_id = get_jwt_identity()
        app.logger.info(f"👋 [BACKEND-LOGOUT] User logging out: {user_id}")
        
        response = jsonify({"message": "Logout successful"})
        unset_jwt_cookies(response)
        
        app.logger.info(f"✅ [BACKEND-LOGOUT] JWT cookie cleared")
        
        return response, 200
        
    except Exception as e:
        app.logger.error(f"❌ [BACKEND-LOGOUT] Logout error: {str(e)}")
        return jsonify({"message": "An error occurred during logout"}), 500


@auth_bp.route('/me', methods=['GET'])
@jwt_required()
def get_current_user():
    """Get current user info from JWT token"""
    try:
        # Get user_id from JWT
        user_id = get_jwt_identity()
        
        # Get additional claims from JWT
        jwt_data = get_jwt()
        
        app.logger.info(f"👤 [BACKEND-ME] Fetching current user info for: {user_id}")
        app.logger.debug(f"🎫 [BACKEND-ME] JWT claims: {jwt_data}")
        
        # Get fresh user data from database
        supabase = get_supabase_client()
        response = supabase.table('users').select('*').eq('id', user_id).execute()
        
        if not response.data or len(response.data) == 0:
            app.logger.warning(f"⚠️ [BACKEND-ME] User not found in database: {user_id}")
            return jsonify({"message": "User not found"}), 404
        
        user = response.data[0]
        
        user_info = {
            "id": user['id'],
            "email": user['email'],
            "name": user.get('name', 'Unknown'),
            "role": user.get('role', 'user'),
            "created_at": user.get('created_at'),
            "updated_at": user.get('updated_at')
        }
        
        app.logger.info(f"✅ [BACKEND-ME] Returning user: {user_info['name']} ({user_info['email']})")
        
        return jsonify(user_info), 200
        
    except Exception as e:
        app.logger.error(f"❌ [BACKEND-ME] Error fetching current user: {str(e)}")
        return jsonify({"message": "An error occurred"}), 500


@auth_bp.route('/check', methods=['GET'])
@jwt_required()
def check_auth():
    """Simple auth check endpoint"""
    try:
        user_id = get_jwt_identity()
        jwt_data = get_jwt()
        
        app.logger.debug(f"🔍 [BACKEND-CHECK] Auth check for user: {user_id}")
        
        return jsonify({
            "authenticated": True,
            "user_id": user_id,
            "email": jwt_data.get('email'),
            "role": jwt_data.get('role')
        }), 200
        
    except Exception as e:
        app.logger.error(f"❌ [BACKEND-CHECK] Auth check error: {str(e)}")
        return jsonify({"authenticated": False}), 401
