from functools import wraps
from flask import jsonify, current_app as app
from flask_jwt_extended import verify_jwt_in_request, get_jwt_identity, get_jwt
from utils.connection_pool import get_supabase_client

def require_auth(f):
    """
    Decorator to require JWT authentication for routes
    Usage: @require_auth
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        try:
            # Verify JWT token is present and valid
            verify_jwt_in_request()
            
            # Get user_id from JWT
            user_id = get_jwt_identity()
            
            app.logger.info(f"Authenticating user_id from JWT: {user_id}")
            
            # Optional: Verify user still exists in database
            supabase = get_supabase_client()
            response = supabase.table('users').select('id').eq('id', user_id).execute()
            
            if not response.data or len(response.data) == 0:
                app.logger.warning(f"User {user_id} not found in database")
                return jsonify({"message": "User not found"}), 404
            
            return f(*args, **kwargs)
            
        except Exception as e:
            app.logger.error(f"Authentication error: {str(e)}")
            return jsonify({"message": "Authentication required"}), 401
    
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
