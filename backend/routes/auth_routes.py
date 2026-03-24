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
import re
from utils.connection_pool import get_supabase_client
from helpers.utils import read_json_file
from config.config import USERS_FILE

auth_bp = Blueprint('auth', __name__)


def _find_local_user_by_email(email: str):
    users = read_json_file(USERS_FILE, [])
    for user in users:
        if str(user.get("email", "")).strip().lower() == email:
            return user
    return None


def _find_local_user_by_id(user_id: str):
    users = read_json_file(USERS_FILE, [])
    for user in users:
        if str(user.get("id")) == str(user_id):
            return user
    return None

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
        
        user = None
        supabase_error = None
        try:
            # Query user from Supabase (primary)
            response = supabase.table('users').select('*').eq('email', email).execute()
            if response.data and len(response.data) > 0:
                user = response.data[0]
        except Exception as e:
            supabase_error = e
            app.logger.warning(f"⚠️ [BACKEND-LOGIN] Supabase unavailable, using local fallback: {e}")

        if user is None:
            # Offline fallback to local JSON cache
            user = _find_local_user_by_email(email)

        if not user:
            app.logger.warning(f"⚠️ [BACKEND-LOGIN] User not found: {email}")
            return jsonify({"message": "Invalid email or password"}), 401
        user_id = user['id']
        stored_password = user.get('password', '')
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
        
        # ✅ UPDATED: Return token in response body for localStorage
        response = jsonify({
            "auth_ok": True,
            "message": "Login successful",
            "access_token": access_token,  # ✅ Added for localStorage
            "user": {
                "id": user_id,
                "email": email,
                "name": user_name
            },
            "user_role": user_role
        })
        
        # ✅ Still set JWT cookie for backward compatibility
        set_access_cookies(response, access_token)
        
        app.logger.info(f"📤 [BACKEND-LOGIN] Sending response with JWT token in body and cookie")
        return response, 200
        
    except Exception as e:
        app.logger.error(f"❌ [BACKEND-LOGIN] Login error: {str(e)}")
        import traceback
        app.logger.error(f"📋 [BACKEND-LOGIN] Traceback: {traceback.format_exc()}")
        if "timed out" in str(e).lower():
            return jsonify({"message": "Supabase timeout. Retry in a moment."}), 503
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
        
        user = None
        try:
            # Get fresh user data from database
            supabase = get_supabase_client()
            response = supabase.table('users').select('*').eq('id', user_id).execute()
            if response.data and len(response.data) > 0:
                user = response.data[0]
        except Exception as e:
            app.logger.warning(f"⚠️ [BACKEND-ME] Supabase unavailable, using local fallback: {e}")

        if user is None:
            user = _find_local_user_by_id(user_id)

        if not user:
            app.logger.warning(f"⚠️ [BACKEND-ME] User not found in Supabase/local JSON: {user_id}")
            # Last fallback: JWT claims only
            return jsonify({
                "id": user_id,
                "email": jwt_data.get("email"),
                "name": jwt_data.get("name", "Unknown"),
                "role": jwt_data.get("role", "user"),
                "offline": True,
            }), 200
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


@auth_bp.route('/forgot-password-proxy', methods=['POST'])
def forgot_password_proxy():
    """
    Local proxy endpoint expected by frontend.
    For desktop/offline-first flow we return a safe generic message and never disclose account existence.
    """
    try:
        data = request.get_json() or {}
        email = str(data.get("email", "")).strip().lower()
        if not email or not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", email):
            return jsonify({"success": False, "message": "Please enter a valid email address."}), 400

        # Best-effort existence check (cloud then local), but response remains generic.
        exists = False
        try:
            supabase = get_supabase_client()
            if supabase and not getattr(supabase, "is_offline_fallback", False):
                response = supabase.table("users").select("id").eq("email", email).limit(1).execute()
                exists = bool(response.data)
        except Exception:
            pass
        if not exists:
            exists = bool(_find_local_user_by_email(email))

        # Avoid account enumeration; always return success.
        if exists:
            app.logger.info(f"🔐 [FORGOT-PASSWORD] Password reset requested for existing user: {email}")
        else:
            app.logger.info(f"🔐 [FORGOT-PASSWORD] Password reset requested for non-existing user: {email}")

        return jsonify({
            "success": True,
            "message": "If an account exists for this email, reset instructions have been sent."
        }), 200
    except Exception as e:
        app.logger.error(f"❌ [FORGOT-PASSWORD] Error: {str(e)}")
        return jsonify({"success": False, "message": "Unable to process request right now."}), 500
