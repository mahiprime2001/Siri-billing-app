import uuid
from flask import Blueprint, request, jsonify, make_response, g, current_app as app

from auth.auth import token_required, active_sessions, save_sessions
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
            
            # Generate session token
            session_token = str(uuid.uuid4())
            active_sessions[session_token] = user_info['id']
            save_sessions(active_sessions) # Persist sessions after login
            
            # Log login event
            log_session_event('LOGIN', user_info.get('id'), 'User logged in to billing app')
            
            return jsonify({
                "auth_ok": True,
                "user_role": user_info.get('role'),
                "user": user_info,
                "session_token": session_token,
                "message": "Login successful"
            }), 200
        
        return jsonify({"message": "Invalid email or password"}), 401
    
    except Exception as e:
        app.logger.error(f"Login error: {e}")
        return jsonify({"message": f"Server error: {str(e)}"}), 500

@auth_bp.route('/logout', methods=['POST'])
@token_required
def logout():
    """Logout endpoint"""
    try:
        session_token = g.session_token
        user_id = g.current_user['id']
        
        if session_token in active_sessions:
            del active_sessions[session_token]
            save_sessions(active_sessions) # Persist sessions after logout
        
        log_session_event('LOGOUT', user_id, 'User logged out from billing app')
        
        return jsonify({"message": "Logout successful"}), 200
    
    except Exception as e:
        app.logger.error(f"Logout error: {e}")
        return jsonify({"message": f"Server error: {str(e)}"}), 500

@auth_bp.route('/me', methods=['GET'])
@token_required
def get_current_user():
    """Get current user info"""
    try:
        user_info = {k: v for k, v in g.current_user.items() if k != 'password'}
        return jsonify({"user": user_info}), 200
    except Exception as e:
        app.logger.error(f"Error getting current user: {e}")
        return jsonify({"message": f"Server error: {str(e)}"}), 500
