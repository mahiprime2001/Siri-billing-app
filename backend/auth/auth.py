from functools import wraps
from flask import request, jsonify, g
import uuid
import json
import os
import logging
from functools import wraps
from flask import request, jsonify, g, current_app as app

from data_access.data_access import get_users_data

# Configure logging for this module
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO) # Set to INFO or DEBUG for more verbose logging

# Determine the base directory of the auth.py file
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SESSION_FILE = os.path.join(BASE_DIR, '..', 'data', 'sessions.json') # Adjust path to be relative to BASE_DIR

def load_sessions():
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE, 'r') as f:
                sessions = json.load(f)
                logger.info(f"Loaded {len(sessions)} active sessions from {SESSION_FILE}")
                return sessions
        except json.JSONDecodeError as e:
            logger.error(f"Error decoding sessions.json: {e}")
            return {}
    logger.info(f"No session file found at {SESSION_FILE}. Starting with empty sessions.")
    return {}

def save_sessions(sessions):
    try:
        with open(SESSION_FILE, 'w') as f:
            json.dump(sessions, f, indent=4)
        logger.info(f"Saved {len(sessions)} active sessions to {SESSION_FILE}")
    except IOError as e:
        logger.error(f"Error saving sessions to {SESSION_FILE}: {e}")

active_sessions = load_sessions()

def token_required(f):
    """Decorator for token-based authentication"""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        if 'Authorization' in request.headers:
            auth_header = request.headers['Authorization']
            parts = auth_header.split(" ")
            if len(parts) == 2 and parts[0].lower() == 'bearer':
                token = parts[1]
        
        if not token:
            logger.warning("Authentication token is missing from request headers.")
            return jsonify({"message": "Token is missing!"}), 401
        
        user_id = active_sessions.get(token)
        if not user_id:
            logger.warning(f"Invalid or expired token received: {token}. Active sessions: {list(active_sessions.keys())}")
            return jsonify({"message": "Token is invalid or expired!"}), 401
        
        users = get_users_data() # Assuming get_users_data is still relevant for user validation
        current_user = next((u for u in users if u.get('id') == user_id), None)
        
        if not current_user:
            logger.warning(f"User not found for user_id: {user_id} associated with token: {token}")
            return jsonify({"message": "User not found!"}), 401
        
        g.current_user = current_user
        g.session_token = token
        logger.info(f"Token validated for user: {user_id}")
        return f(*args, **kwargs)
    
    return decorated
