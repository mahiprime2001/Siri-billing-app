from functools import wraps
from flask import jsonify, current_app as app
from flask_jwt_extended import verify_jwt_in_request, get_jwt_identity, get_jwt
from utils.connection_pool import get_supabase_client
from utils.known_issues_log import log_known_issue  # TEMPORARY — see that module's docstring

def require_auth(f):
    """
    Decorator to require JWT authentication for routes
    Usage: @require_auth
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # The JWT itself (signature + expiry) IS the authentication. Only a
        # failure here means the caller is genuinely not authenticated.
        try:
            verify_jwt_in_request()
            user_id = get_jwt_identity()
            app.logger.info(f"Authenticating user_id from JWT: {user_id}")
        except Exception as e:
            app.logger.error(f"Authentication error: {str(e)}")
            return jsonify({"message": "Authentication required"}), 401

        # Optional: verify the user still exists (defense-in-depth revocation
        # check, not the authentication itself). This used to sit inside the
        # same try/except as the JWT check above, so a Supabase network blip
        # (e.g. a DNS hiccup) here got reported as "Authentication required"
        # and logged out an otherwise validly-authenticated request — on
        # every route, since require_auth gates almost all of them. A DB/
        # network failure here must degrade like the existing offline-
        # fallback path already does, not masquerade as an auth failure.
        try:
            supabase = get_supabase_client()
            response = supabase.table('users').select('id').eq('id', user_id).execute()
            if not response.data:
                if getattr(supabase, "is_offline_fallback", False):
                    app.logger.warning(
                        f"User {user_id} not found in local fallback users snapshot; allowing JWT-authenticated request in offline mode."
                    )
                else:
                    app.logger.warning(f"User {user_id} not found in database")
                    return jsonify({"message": "User not found"}), 404
        except Exception as e:
            app.logger.warning(
                f"User-existence check failed for {user_id} ({e}); trusting the JWT and proceeding."
            )
            # TEMPORARY — remove this call and known_issues_log.py once the
            # underlying connectivity flakiness is confirmed fixed.
            log_known_issue("auth.require_auth", f"user={user_id} error={e}")

        return f(*args, **kwargs)

    return decorated_function


def require_role(*allowed_roles):
    """
    Decorator to require specific roles for routes
    Usage: @require_role('admin', 'billing_user')
    """
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            try:
                verify_jwt_in_request()
                
                jwt_data = get_jwt()
                user_role = jwt_data.get('role')
                user_id = get_jwt_identity()
                
                app.logger.info(f"Checking role for user {user_id}: {user_role}")
                
                if user_role not in allowed_roles:
                    app.logger.warning(f"Access denied for user {user_id} with role {user_role}")
                    return jsonify({"message": "Insufficient permissions"}), 403
                
                return f(*args, **kwargs)
                
            except Exception as e:
                app.logger.error(f"Role check error: {str(e)}")
                return jsonify({"message": "Authentication required"}), 401
        
        return decorated_function
    return decorator
