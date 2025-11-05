from functools import wraps
from flask import request, jsonify, g, current_app as app, session
from data_access.data_access import get_users_data
import logging

# Configure logging for this module
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

def session_required(f):
    """Decorator for session-based authentication (replaces token_required)"""
    @wraps(f)
    def decorated(*args, **kwargs):
        # Check if user_id exists in session
        user_id = session.get('user_id')
        
        if not user_id:
            logger.warning("Session authentication failed. User not logged in.")
            return jsonify({"message": "Authentication token is missing!"}), 401
        
        app.logger.info(f"Authenticating user_id from session: {user_id}")
        
        # Get user data
        users = get_users_data()
        current_user = next((u for u in users if u.get('id') == user_id), None)
        
        if not current_user:
            logger.warning(f"User not found for user_id: {user_id} from session.")
            # Clear invalid session
            session.pop('user_id', None)
            return jsonify({"message": "Invalid authentication token!"}), 401
        
        # Store user in Flask's g object for use in the route
        g.current_user = current_user
        logger.info(f"Session validated for user: {user_id}")
        
        return f(*args, **kwargs)
    
    return decorated

# Keep old name for backwards compatibility (optional)
token_required = session_required
