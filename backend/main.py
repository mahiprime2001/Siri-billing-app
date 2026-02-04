import os
import sys
import json
import time
import re
import logging
import shutil
import tempfile
import glob
from datetime import datetime, timedelta, timezone, date
from decimal import Decimal
from urllib.parse import urlparse
from pathlib import Path
from flask import Flask, request, jsonify, make_response, g
from flask_jwt_extended import JWTManager, get_jwt, get_jwt_identity, jwt_required
import threading
import uuid
import atexit
from dotenv import load_dotenv
from functools import wraps
import signal

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
from routes.stock_stream_routes import stock_stream_bp

if sys.platform == 'win32':
    import codecs
    # Set stdout and stderr to use UTF-8
    if sys.stdout.encoding != 'utf-8':
        sys.stdout = codecs.getwriter('utf-8')(sys.stdout.buffer, 'strict')
    if sys.stderr.encoding != 'utf-8':
        sys.stderr = codecs.getwriter('utf-8')(sys.stderr.buffer, 'strict')
    # Set environment variable for subprocess/PyInstaller
    os.environ['PYTHONIOENCODING'] = 'utf-8'

app = Flask(__name__)

if getattr(sys, 'frozen', False):
    # Running in PyInstaller bundle
    BASE_PATH = sys._MEIPASS
else:
    # Running in normal Python environment
    BASE_PATH = os.path.dirname(os.path.abspath(__file__))

# Load .env file from the correct location
env_path = os.path.join(BASE_PATH, '.env')
if os.path.exists(env_path):
    load_dotenv(env_path)
    print(f"Loaded .env from: {env_path}")
else:
    # Try parent directory (for development)
    parent_env = os.path.join(os.path.dirname(BASE_PATH), '.env')
    if os.path.exists(parent_env):
        load_dotenv(parent_env)
        print(f"Loaded .env from: {parent_env}")
    else:
        print(f"⚠️ No .env file found at {env_path} or {parent_env}")

# ==================== PYINSTALLER CLEANUP FUNCTION ====================
def cleanup_pyinstaller_temp_folders(keep_newest=True):
    """Clean PyInstaller _MEI* temp folders, optionally keeping the newest one"""
    temp_dirs = []
    
    # Find all _MEI* folders in standard temp locations
    temp_paths = [
        tempfile.gettempdir(),
        os.path.join(os.path.expanduser('~'), 'AppData', 'Local', 'Temp'),  # Windows
        '/tmp',  # Linux/Mac
    ]
    
    for temp_path in temp_paths:
        if os.path.exists(temp_path):
            mei_dirs = glob.glob(os.path.join(temp_path, '_MEI*'))
            temp_dirs.extend([Path(d) for d in mei_dirs])
    
    if not temp_dirs:
        app.logger.info("🧹 No PyInstaller temp folders found")
        return
    
    app.logger.info(f"🧹 Found {len(temp_dirs)} PyInstaller temp folders")
    
    if keep_newest and len(temp_dirs) > 1:
        # Sort by modification time, keep newest
        temp_dirs.sort(key=lambda x: x.stat().st_mtime, reverse=True)
        temp_dirs = temp_dirs[1:]  # Remove newest (current running app)
        app.logger.info("🧹 Keeping newest folder, cleaning others")
    
    for temp_dir in temp_dirs:
        try:
            if temp_dir.exists():
                shutil.rmtree(temp_dir)
                app.logger.info(f"✅ Cleaned: {temp_dir}")
        except Exception as e:
            app.logger.error(f"❌ Failed to clean {temp_dir}: {e}")

# ==================== GRACEFUL SHUTDOWN ENDPOINT ====================
@app.route('/api/shutdown', methods=['POST'])
def shutdown_server():
    """Graceful shutdown endpoint for Tauri - cleans up and exits"""
    app.logger.info("🛑 Shutdown requested via HTTP from Tauri")
    
    def perform_shutdown():
        app.logger.info("🧹 Performing final cleanup...")
        cleanup_pyinstaller_temp_folders(keep_newest=False)  # Clean ALL folders
        close_supabase_client()
        app.logger.info("✅ Cleanup complete, exiting with os._exit(0)")
        os._exit(0)
    
    # Schedule shutdown in 1 second to return response first
    threading.Timer(1.0, perform_shutdown).start()
    return jsonify({'message': 'Server shutting down gracefully...'}), 200

# ==================== JWT CONFIGURATION ====================
app.config['JWT_SECRET_KEY'] = os.environ.get('JWT_SECRET_KEY', 'dev-secret-key-change-in-production')
app.config['JWT_TOKEN_LOCATION'] = ['headers', 'cookies']
app.config['JWT_COOKIE_SECURE'] = False
app.config['JWT_COOKIE_CSRF_PROTECT'] = False
app.config['JWT_COOKIE_SAMESITE'] = 'Lax'
app.config['JWT_ACCESS_TOKEN_EXPIRES'] = timedelta(hours=2)
app.config['JWT_COOKIE_NAME'] = 'access_token_cookie'
app.config['JWT_ACCESS_COOKIE_PATH'] = '/'
app.config['JWT_COOKIE_DOMAIN'] = None

# Initialize JWT Manager
jwt = JWTManager(app)

# Initialize connection pool and sync controller
initialize_supabase_client()
sync_controller = SyncController()

# Configure logging
setup_logging(app, LOG_FILE)
app.logger.info(" Billing Flask server starting up...")
app.logger.info(f"JWT Configuration:")
app.logger.info(f"JWT_TOKEN_LOCATION: {app.config['JWT_TOKEN_LOCATION']}")
app.logger.info(f"JWT_COOKIE_NAME: {app.config['JWT_COOKIE_NAME']}")
app.logger.info(f"JWT_COOKIE_SECURE: {app.config['JWT_COOKIE_SECURE']}")
app.logger.info(f"JWT_COOKIE_SAMESITE: {app.config['JWT_COOKIE_SAMESITE']}")
app.logger.info(f"JWT_ACCESS_TOKEN_EXPIRES: {app.config['JWT_ACCESS_TOKEN_EXPIRES']}")
app.logger.info(f"JWT_ACCESS_COOKIE_PATH: {app.config['JWT_ACCESS_COOKIE_PATH']}")
app.logger.info(f"JWT_COOKIE_DOMAIN: {app.config['JWT_COOKIE_DOMAIN']}")

# ==================== JWT CALLBACKS ====================
@jwt.expired_token_loader
def expired_token_callback(jwt_header, jwt_payload):
    app.logger.warning(f"[JWT] Token expired for user: {jwt_payload.get('sub')}")
    return jsonify({
        'message': 'Token has expired',
        'error': 'token_expired'
    }), 401

@jwt.invalid_token_loader
def invalid_token_callback(error):
    app.logger.warning(f"[JWT] Invalid token: {error}")
    return jsonify({
        'message': 'Invalid token',
        'error': 'invalid_token'
    }), 401

@jwt.unauthorized_loader
def missing_token_callback(error):
    app.logger.debug(f"[JWT] No token provided: {error}")
    app.logger.debug(f"[JWT] Request cookies: {request.cookies}")
    app.logger.debug(f"[JWT] Request headers: {request.headers.get('Authorization')}")
    return jsonify({
        'message': 'Authorization token required',
        'error': 'authorization_required'
    }), 401

# ==================== CORS HELPER FUNCTION ====================
def is_local_origin(origin):
    if not origin:
        return False
    try:
        parsed = urlparse(origin)
        hostname = parsed.hostname
        
        if parsed.scheme == 'file':
            return True
        
        if hostname in ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'tauri.localhost']:
            return True
        
        if hostname and (
            hostname.startswith('192.168.') or
            hostname.startswith('10.') or
            hostname.startswith('172.')
        ):
            return True
        
        return False
    except Exception as e:
        app.logger.warning(f"[CORS] Error parsing origin {origin}: {e}")
        return False

# ==================== CORS CONFIGURATION ====================
@app.after_request
def after_request(response):
    origin = request.headers.get('Origin')
    app.logger.debug(f"[CORS] Request from origin: {origin}")
    app.logger.debug(f"[CORS] Request path: {request.path}")
    
    if not origin:
        origin = 'http://localhost:1420'
    
    if is_local_origin(origin) or not request.headers.get('Origin'):
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Access-Control-Allow-Credentials'] = 'true'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With'
        response.headers['Access-Control-Expose-Headers'] = 'Content-Type, Set-Cookie'
        app.logger.debug(f"[CORS] Added CORS headers for origin: {origin}")
    
    return response

@app.before_request
def handle_preflight():
    if request.method == 'OPTIONS':
        app.logger.debug(f"[CORS-PREFLIGHT] Handling OPTIONS request for {request.path}")
        response = make_response()
        origin = request.headers.get('Origin')
        
        if not origin:
            origin = 'http://localhost:1420'
        
        if is_local_origin(origin) or not request.headers.get('Origin'):
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Access-Control-Allow-Credentials'] = 'true'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With'
            response.headers['Access-Control-Max-Age'] = '3600'
            app.logger.debug(f"[CORS-PREFLIGHT] Allowed for origin: {origin}")
        
        return response

@atexit.register
def cleanup():
    """Cleanup function called on application shutdown"""
    print("🧹 [MAIN] Application shutting down, closing connections...")
    cleanup_pyinstaller_temp_folders(keep_newest=False)
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
app.register_blueprint(stock_stream_bp, url_prefix='/api')

# ==================== Main ====================
if __name__ == '__main__':
    app.logger.info("Billing Flask server starting...")
    
    # 🆕 CLEANUP OLD PYINSTALLER FOLDERS ON STARTUP
    cleanup_pyinstaller_temp_folders(keep_newest=True)
    
    port = 8080
    host = 'localhost'
    app.logger.info(f"Billing app will run on {host}:{port}")
    app.logger.info(f"CORS: Accepting all requests from local machine")
    app.logger.info("🛑 Shutdown endpoint available at /api/shutdown (POST)")
    
    # Start background tasks
    start_background_tasks(app)
    
    try:
        app.run(debug=True, port=port, host=host)
    except Exception as e:
        app.logger.error(f"Failed to start billing Flask server: {e}")
    finally:
        close_supabase_client()
