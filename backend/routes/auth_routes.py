import uuid
from datetime import datetime, timezone # Added datetime and timezone
from flask import Blueprint, request, jsonify, make_response, g, current_app as app, session
from auth.auth import session_required  # Use session_required instead of token_required
from data_access.data_access import get_users_data
from session_logging.session_logging import log_session_event

auth_bp = Blueprint('auth_bp', __name__)

@auth_bp.route('/login', methods=['POST', 'OPTIONS'])
def login():
    """Login endpoint"""
    if request.method == 'OPTIONS':
        response = make_response()
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add("Access-Control-Allow-Methods", "POST, OPTIONS")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        return response, 200
    
    try:
        data = request.json
        if not data:
            return jsonify({"message": "Request body is required"}), 400
        
        email = data.get('email')
        password = data.get('password')
        
        if not email or not password:
            return jsonify({"message": "Email and password are required"}), 400
        
        users = get_users_data()
        user = next((u for u in users if u.get('email', '').lower() == email.lower()), None)
        
        if user and user.get('password') == password:
            user_info = {k: v for k, v in user.items() if k != 'password'}
            
            # Store user ID in Flask session (server-side)
            session['user_id'] = user_info['id']
            session.permanent = True  # Session is permanent, idle timeout handled by main.py
            session['last_activity'] = datetime.now(timezone.utc).isoformat() # Set initial activity
            
            app.logger.info(f"User ID {user_info['id']} stored in session after login. Session set to permanent.")
            
            # Log login event
            log_session_event('LOGIN', user_info.get('id'), 'User logged in to billing app')
            
            # Return user info WITHOUT token (session handles auth)
            return jsonify({
                "auth_ok": True,
                "user_role": user_info.get('role'),
                "user": user_info,
                "message": "Login successful"
            }), 200
        
        return jsonify({"message": "Invalid email or password"}), 401
    
    except Exception as e:
        app.logger.error(f"Login error: {e}")
        return jsonify({"message": f"Server error: {str(e)}"}), 500

@auth_bp.route('/logout', methods=['POST'])
@session_required
def logout():
    """Logout endpoint"""
    try:
        user_id = session.pop('user_id', None)  # Remove user_id from session
        
        if user_id:
            log_session_event('LOGOUT', user_id, 'User logged out from billing app')
        
        # Clear entire session
        session.clear()
        
        return jsonify({"message": "Logout successful"}), 200
    
    except Exception as e:
        app.logger.error(f"Logout error: {e}")
        return jsonify({"message": f"Server error: {str(e)}"}), 500

@auth_bp.route('/me', methods=['GET', 'OPTIONS'])
@session_required
def get_current_user():
    """Get current user info"""
    if request.method == 'OPTIONS':
        response = make_response()
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add("Access-Control-Allow-Methods", "GET, OPTIONS")
        response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        return response, 200
    
    try:
        user_info = {k: v for k, v in g.current_user.items() if k != 'password'}
        return jsonify({"user": user_info}), 200
    
    except Exception as e:
        app.logger.error(f"Error getting current user: {e}")
        return jsonify({"message": f"Server error: {str(e)}"}), 500
