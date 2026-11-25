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
from utils.siri_api import get_client as get_siri_client
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

def _login_response(user_id, email, user_name, user_role):
    """The local session for a person whose password has been checked (the same answer whichever way it was checked)."""
    access_token = create_access_token(
        identity=user_id,
        additional_claims={"email": email, "name": user_name, "role": user_role},
    )
    response = jsonify({
        "auth_ok": True,
        "message": "Login successful",
        "access_token": access_token,
        "user": {"id": user_id, "email": email, "name": user_name},
        "user_role": user_role,
    })
    set_access_cookies(response, access_token)
    return response, 200


def _login_through_siri(email, password):
    """With the "auth" switch on, siri-api checks the password (the PC never reads the users table).
    Returns a finished response, or None to carry on with the old way (only when siri-api could not be reached AND
    this person has never logged in online here, so there is nothing to check against offline)."""
    from utils import offline_credentials
    api = get_siri_client()
    if not api.switch_on("auth"):
        return None
    verdict, siri_user = api.login_verdict(email, password)
    if verdict == "ok" and siri_user and siri_user.get("id"):
        offline_credentials.save(email, password, siri_user)
        try:
            api.switches(force=True)
        except Exception:  # noqa: BLE001
            pass
        app.logger.info(f"SIRI_API auth login ok user={siri_user['id']}")
        return _login_response(siri_user["id"], email, siri_user.get("name") or "Unknown", siri_user.get("role") or "user")
    if verdict == "refused":
        offline_credentials.forget(email)
        app.logger.warning(f"SIRI_API auth login refused for {email}")
        return jsonify({"message": "Invalid email or password"}), 401
    offline_user = offline_credentials.check(email, password)
    if offline_user:
        app.logger.info(f"SIRI_API auth offline login ok user={offline_user['id']} (siri-api not reachable)")
        _restore_siri_login_later(email, password)
        return _login_response(offline_user["id"], email, offline_user.get("name") or "Unknown", offline_user.get("role") or "user")
    app.logger.warning(f"SIRI_API FALLBACK group=auth login for {email}: siri-api not reachable and no offline copy")
    return None


def _restore_siri_login_later(email, password):
    """An offline login: keep trying the siri-api login in the background so the token and switches come back."""
    try:
        get_siri_client().keep_trying_login(email, password)
    except Exception as e:  # noqa: BLE001
        app.logger.warning(f"SIRI_API login retry could not start: {e}")


def _offline_copy_login(email, password):
    """No internet and the old check did not pass: a password siri-api accepted earlier on this PC (its scrambled
    copy) is still good, whatever the switches say. (On 2026-11-25 Nellore's switches had gone stale offline, the
    app took the old path, the local user list had no passwords any more, and every login said "invalid password".)"""
    from utils import offline_credentials
    offline_user = offline_credentials.check(email, password)
    if not offline_user:
        return None
    app.logger.info(f"SIRI_API offline-copy login ok user={offline_user['id']} (no internet, old check could not pass)")
    _restore_siri_login_later(email, password)
    return _login_response(offline_user["id"], email, offline_user.get("name") or "Unknown", offline_user.get("role") or "user")


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

        through_siri = _login_through_siri(email, password)
        if through_siri is not None:
            return through_siri

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

        # No internet: either the database call failed, or the client is the local offline stand-in (that one does
        # not fail, it answers from the PC's own files). Both mean "the real database was not asked".
        db_unreachable = supabase_error is not None or bool(getattr(supabase, "is_offline_fallback", False))

        if not user:
            if db_unreachable:
                by_copy = _offline_copy_login(email, password)
                if by_copy is not None:
                    return by_copy
            app.logger.warning(f"⚠️ [BACKEND-LOGIN] User not found: {email}")
            return jsonify({"message": "Invalid email or password"}), 401
        user_id = user['id']
        stored_password = user.get('password', '')
        user_name = user.get('name', 'Unknown')
        user_role = user.get('role', 'user')
        
        # Simple password comparison (no hashing)
        if password != stored_password:
            if db_unreachable:
                by_copy = _offline_copy_login(email, password)
                if by_copy is not None:
                    return by_copy
            app.logger.warning(f"⚠️ [BACKEND-LOGIN] Invalid password for user: {email}")
            return jsonify({"message": "Invalid email or password"}), 401
        
        # Also log in to siri-api in the background (it gives this computer the token and the offline "replay
        # passes" the migration needs). Best effort only: it can never slow down, fail, or change this login.
        try:
            get_siri_client().login_in_background(email, password)
        except Exception as siri_err:
            app.logger.warning(f"SIRI_API background login could not start: {siri_err}")

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
        
        try:
            get_siri_client().drop_access_token()      # the replay passes stay: queued offline bills still need them
        except Exception as siri_err:
            app.logger.warning(f"SIRI_API logout cleanup failed: {siri_err}")

        response = jsonify({"message": "Logout successful"})
        unset_jwt_cookies(response)
        app.logger.info(f"✅ [BACKEND-LOGOUT] JWT cookie cleared")
        return response, 200
        
    except Exception as e:
        app.logger.error(f"❌ [BACKEND-LOGOUT] Logout error: {str(e)}")
        return jsonify({"message": "An error occurred during logout"}), 500


@auth_bp.route('/front-door-session', methods=['POST'])
def front_door_session():
    """Rust offline mode (piece 3): the app's Rust front door has checked an offline login against its scrambled
    copy (every cashier of the store) and asks for the normal session. Only the front door can ask: it proves it with
    the one-time key the app gave this backend at start (SIRI_FRONT_KEY, a fresh random value each start). With no
    key set (front door off) this route does not exist."""
    import hmac as _hmac
    import os as _os
    key = _os.environ.get("SIRI_FRONT_KEY", "")
    given = request.headers.get("X-Front-Door-Key", "")
    if not key or not given or not _hmac.compare_digest(key, given):
        return jsonify({"message": "Not found"}), 404
    data = request.get_json(silent=True) or {}
    user_id = str(data.get("id") or "").strip()
    email = str(data.get("email") or "").strip().lower()
    if not user_id or not email:
        return jsonify({"message": "id and email are required"}), 400
    app.logger.info(f"SIRI_API front-door offline login ok user={user_id} (checked by Rust against its copy)")
    return _login_response(user_id, email, data.get("name") or "Unknown", data.get("role") or "user")


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

        # The answer is the same either way (no account enumeration), so only the local copy is looked at for the
        # log line; the database is not asked (one less use of the master key).
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
