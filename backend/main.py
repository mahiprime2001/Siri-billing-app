import os
import sys
import json
import time
import re
import logging
from datetime import datetime, timedelta, timezone, date
from decimal import Decimal
from urllib.parse import urlparse
from flask import Flask, request, jsonify, make_response, g
from flask_jwt_extended import JWTManager, get_jwt, get_jwt_identity
import threading
import uuid
import atexit
from functools import wraps

# Import connection pool and sync controller
from utils.connection_pool import initialize_supabase_client, get_supabase_client, close_supabase_client
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
from routes.notification_routes import notification_bp

app = Flask(__name__)

# ==================== JWT CONFIGURATION ====================
app.config['JWT_SECRET_KEY'] = os.environ.get('JWT_SECRET_KEY', 'dev-secret-key-change-in-production')
app.config['JWT_TOKEN_LOCATION'] = ['cookies']
app.config['JWT_COOKIE_SECURE'] = False  # Set to True in production with HTTPS
app.config['JWT_COOKIE_CSRF_PROTECT'] = False  # We're using SameSite instead
app.config['JWT_COOKIE_SAMESITE'] = 'Lax'
app.config['JWT_ACCESS_TOKEN_EXPIRES'] = timedelta(hours=24)
app.config['JWT_COOKIE_NAME'] = 'access_token_cookie'

# Initialize JWT Manager
jwt = JWTManager(app)

# Initialize connection pool and sync controller
initialize_supabase_client()
sync_controller = SyncController()

# Configure logging
setup_logging(app, LOG_FILE)

app.logger.info("🚀 Billing Flask server starting up...")
app.logger.info(f"🔐 JWT Configuration:")
app.logger.info(f"  - JWT_TOKEN_LOCATION: {app.config['JWT_TOKEN_LOCATION']}")
app.logger.info(f"  - JWT_COOKIE_NAME: {app.config['JWT_COOKIE_NAME']}")
app.logger.info(f"  - JWT_COOKIE_SECURE: {app.config['JWT_COOKIE_SECURE']}")
app.logger.info(f"  - JWT_COOKIE_SAMESITE: {app.config['JWT_COOKIE_SAMESITE']}")
app.logger.info(f"  - JWT_ACCESS_TOKEN_EXPIRES: {app.config['JWT_ACCESS_TOKEN_EXPIRES']}")

# ==================== JWT CALLBACKS ====================
@jwt.expired_token_loader
def expired_token_callback(jwt_header, jwt_payload):
    """Called when JWT token has expired"""
    app.logger.warning(f"⏰ [JWT] Token expired for user: {jwt_payload.get('sub')}")
    return jsonify({
        'message': 'Token has expired',
        'error': 'token_expired'
    }), 401

@jwt.invalid_token_loader
def invalid_token_callback(error):
    """Called when JWT token is invalid"""
    app.logger.warning(f"❌ [JWT] Invalid token: {error}")
    return jsonify({
        'message': 'Invalid token',
        'error': 'invalid_token'
    }), 401

@jwt.unauthorized_loader
def missing_token_callback(error):
    """Called when JWT token is missing"""
    app.logger.debug(f"🔍 [JWT] No token provided: {error}")
    return jsonify({
        'message': 'Authorization token required',
        'error': 'authorization_required'
    }), 401

# ==================== CORS HELPER FUNCTION ====================
def is_local_origin(origin):
    """Check if the origin is from localhost/127.0.0.1 (any port) or a local file"""
    if not origin:
        return False
    
    try:
        parsed = urlparse(origin)
        hostname = parsed.hostname
        
        if parsed.scheme == 'file':
            return True
        
        if hostname in ['localhost', '127.0.0.1', '0.0.0.0', '[::1]']:
            return True
        
        if hostname and (
            hostname.startswith('192.168.') or
            hostname.startswith('10.') or
            hostname.startswith('172.')
        ):
            return True
        
        return False
    except Exception as e:
        app.logger.warning(f"⚠️ [CORS] Error parsing origin {origin}: {e}")
        return False

# ==================== CORS CONFIGURATION ====================
@app.after_request
def after_request(response):
    """Add CORS headers to every response"""
    origin = request.headers.get('Origin')
    
    app.logger.debug(f"🔍 [CORS] Request from origin: {origin}")
    app.logger.debug(f"🔍 [CORS] Request path: {request.path}")
    
    if is_local_origin(origin):
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Access-Control-Allow-Credentials'] = 'true'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With'
        response.headers['Access-Control-Expose-Headers'] = 'Content-Type, Set-Cookie'
        
        app.logger.debug(f"✅ [CORS] Added CORS headers for local origin: {origin}")
    elif not origin:
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With'
        
        app.logger.debug(f"✅ [CORS] No origin header - allowing direct access")
    
    return response

@app.before_request
def handle_preflight():
    """Handle OPTIONS requests for CORS preflight"""
    if request.method == 'OPTIONS':
        app.logger.debug(f"🔍 [CORS-PREFLIGHT] Handling OPTIONS request for {request.path}")
        
        response = make_response()
        origin = request.headers.get('Origin')
        
        if is_local_origin(origin):
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Access-Control-Allow-Credentials'] = 'true'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With'
            response.headers['Access-Control-Max-Age'] = '3600'
            
            app.logger.debug(f"✅ [CORS-PREFLIGHT] Allowed for local origin: {origin}")
        elif not origin:
            response.headers['Access-Control-Allow-Origin'] = '*'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With'
            response.headers['Access-Control-Max-Age'] = '3600'
        
        return response

@atexit.register
def cleanup():
    """Cleanup function called on application shutdown"""
    print("🧹 [MAIN] Application shutting down, closing connections...")
    close_supabase_client()


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
app.register_blueprint(notification_bp, url_prefix='/api')

# ==================== Main ====================
if __name__ == '__main__':
    app.logger.info("🚀 Billing Flask server starting...")
    
    port = 8080
    host = 'localhost'
    
    app.logger.info(f"🌐 Billing app will run on {host}:{port}")
    app.logger.info(f"🔓 CORS: Accepting all requests from local machine")
    
    # Start background tasks
    start_background_tasks(app)
    
    try:
        app.run(debug=True, port=port, host=host)
    except Exception as e:
        app.logger.error(f"❌ Failed to start billing Flask server: {e}")
    finally:
        close_supabase_client()
