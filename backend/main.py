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
from flask_cors import CORS
import threading
import uuid
from functools import wraps

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

# Initialize connection pool and sync controller
initialize_pool()
sync_controller = SyncController()

# Configure logging
setup_logging(app, LOG_FILE)

app.logger.info("Billing Flask server starting up...")

# Enable CORS - UPDATED VERSION
CORS(app, 
     resources={r"/api/*": {
         "origins": ["http://localhost:3000", "http://127.0.0.1:3000"],
         "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
         "allow_headers": ["Content-Type", "Authorization", "Accept"],
         "expose_headers": ["Content-Type", "Authorization"],
         "supports_credentials": True,
         "max_age": 3600
     }},
     supports_credentials=True)

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
    
    # Hardcoded to run on localhost:8080
    port = 8080
    host = '127.0.0.1'
    
    app.logger.info(f"Billing app will run on {host}:{port}")
    
    # Start background pull sync (every 5 minutes)
    start_background_tasks(app)
    
    try:
        app.run(debug=True, port=port, host=host)
    except Exception as e:
        app.logger.error(f"Failed to start billing Flask server: {e}")
    finally:
        close_pool()
