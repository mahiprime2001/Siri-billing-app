import os
import sys
import json
import time
import re
import logging
from datetime import datetime, timedelta, timezone, date
from decimal import Decimal
from urllib.parse import urlparse
from flask import Flask, request, jsonify, make_response, g, session
from flask_session import Session # Import Flask-Session
from flask_sqlalchemy import SQLAlchemy # Import Flask-SQLAlchemy
import threading
import uuid
from functools import wraps
# Remove Flask-CORS import - we'll implement manually
# from flask_cors import CORS

# Import connection pool and sync controller
from utils.connection_pool import initialize_pool, get_connection, close_pool
from utils.sync_controller import SyncController, json_serial as sync_json_serial

# Import refactored modules
from config.config import LOG_FILE
from logger.logger import setup_logging
from background_tasks.background_tasks import start_background_tasks

# Import API routes
from routes.auth_routes import auth_bp
from routes.user_routes import user_bp
from routes.product_routes import product_bp
from routes.store_routes import store_bp
from routes.settings_routes import settings_bp
from routes.customer_routes import customer_bp
from routes.billing_routes import billing_bp
from routes.return_routes import return_bp
from routes.sync_routes import sync_bp
from routes.health_routes import health_bp

app = Flask(__name__)

# Configure Flask-SQLAlchemy for session storage
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('SQLALCHEMY_DATABASE_URI', 'sqlite:///sessions.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)

# Configure Flask sessions to use SQLAlchemy
app.config['SESSION_TYPE'] = 'sqlalchemy'
app.config['SESSION_SQLALCHEMY'] = db
app.config['SESSION_SQLALCHEMY_TABLE'] = 'flask_sessions' # Custom table name

app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'super_secret_key_for_dev')
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SECURE'] = False
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_DOMAIN'] = None
app.config['SESSION_COOKIE_PATH'] = '/'
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=7) # Set a long total lifetime, idle timeout handled manually
app.config['SESSION_REFRESH_EACH_REQUEST'] = True # Refresh session on each request for idle timeout

# Initialize Flask-Session
server_session = Session(app)

# Initialize connection pool and sync controller
initialize_pool()
sync_controller = SyncController()

# Configure logging
setup_logging(app, LOG_FILE)

app.logger.info("Billing Flask server starting up...")

# Manual CORS implementation - REPLACES Flask-CORS
@app.after_request
def after_request(response):
    """Add CORS headers to every response"""
    origin = request.headers.get('Origin')
    
    # Only allow localhost:3000
    if origin == 'http://localhost:3000':
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Access-Control-Allow-Credentials'] = 'true'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
        response.headers['Access-Control-Expose-Headers'] = 'Content-Type'
    
    return response

@app.before_request
def handle_preflight():
    """Handle OPTIONS requests for CORS preflight"""
    if request.method == 'OPTIONS':
        response = make_response()
        origin = request.headers.get('Origin')
        
        if origin == 'http://localhost:3000':
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Access-Control-Allow-Credentials'] = 'true'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
            response.headers['Access-Control-Max-Age'] = '3600'
        
        return response

@app.before_request
def update_last_activity():
    """Update the last activity timestamp in the session."""
    if 'user_id' in session: # Only update if a user is logged in
        session['last_activity'] = datetime.now(timezone.utc).isoformat()
        app.logger.debug(f"Session last activity updated for user_id: {session.get('user_id')}")

@app.before_request
def check_session_timeout():
    """Check if the session has been idle for too long and clear it."""
    if 'user_id' in session and 'last_activity' in session:
        last_activity_str = session['last_activity']
        last_activity = datetime.fromisoformat(last_activity_str)
        
        idle_timeout_minutes = 120 # 2 hours
        
        if (datetime.now(timezone.utc) - last_activity) > timedelta(minutes=idle_timeout_minutes):
            app.logger.info(f"Session timed out for user_id: {session.get('user_id')}. Clearing session.")
            session.clear()
            # Optionally, you might want to redirect or return an error here
            # For API, returning an unauthorized status is more appropriate
            if request.path.startswith('/api') and not request.path.startswith('/api/auth/login'):
                return jsonify({"message": "Session expired, please log in again."}), 401
    
    # If no user_id in session, or if it's a new session, mark it as permanent
    # This ensures the session cookie is sent with an expiry
    if 'user_id' in session:
        session.permanent = True
    else:
        session.permanent = False # For non-logged in users, session is not permanent

# Register blueprints
app.register_blueprint(auth_bp, url_prefix='/api/auth')
app.register_blueprint(user_bp, url_prefix='/api')
app.register_blueprint(product_bp, url_prefix='/api')
app.register_blueprint(store_bp, url_prefix='/api')
app.register_blueprint(settings_bp, url_prefix='/api')
app.register_blueprint(customer_bp, url_prefix='/api')
app.register_blueprint(billing_bp, url_prefix='/api')
app.register_blueprint(return_bp, url_prefix='/api')
app.register_blueprint(sync_bp, url_prefix='/api')
app.register_blueprint(health_bp, url_prefix='/api')

# ==================== Main ====================

if __name__ == '__main__':
    app.logger.info("Billing Flask server starting...")
    
    # Hardcoded to run on localhost:8080 for consistency with cookie domain
    port = 8080
    host = 'localhost'
    
    app.logger.info(f"Billing app will run on {host}:{port}")
    
    # Start background pull sync (every 5 minutes)
    start_background_tasks(app)
    
    # Create session table if it doesn't exist
    with app.app_context():
        db.create_all()
        app.logger.info("SQLAlchemy session table ensured.")
    
    try:
        app.run(debug=True, port=port, host=host)
    except Exception as e:
        app.logger.error(f"Failed to start billing Flask server: {e}")
    finally:
        close_pool()
