import os
import sys
import json
import time
import re
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime, timedelta, timezone, date
from decimal import Decimal
from urllib.parse import urlparse
from flask import Flask, request, jsonify, make_response
from flask_cors import CORS
from dotenv import load_dotenv
import threading
import uuid # Added for generating UUIDs

# New imports for connection pool and sync controller
from utils.connection_pool import initialize_pool, get_connection, close_pool
from utils.sync_controller import SyncController, json_serial as sync_json_serial

# Define file paths for the 5 main JSON files
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DOTENV_PATH = os.path.join(BASE_DIR, '.env')
load_dotenv(dotenv_path=DOTENV_PATH)

USERS_FILE = os.path.join(BASE_DIR, 'data', 'json', 'users.json')
PRODUCTS_FILE = os.path.join(BASE_DIR, 'data', 'json', 'products.json')
BILLS_FILE = os.path.join(BASE_DIR, 'data', 'json', 'bills.json')
CUSTOMERS_FILE = os.path.join(BASE_DIR, 'data', 'json', 'customers.json')
SYSTEM_SETTINGS_FILE = os.path.join(BASE_DIR, 'data', 'json', 'systemsettings.json')
STORES_FILE = os.path.join(BASE_DIR, 'data', 'json', 'stores.json')
BILL_FORMATS_FILE = os.path.join(BASE_DIR, 'data', 'json', 'billformats.json')
RETURNS_FILE = os.path.join(BASE_DIR, 'data', 'json', 'returns.json')

app = Flask(__name__)

# Configure logging
DATA_DIR = os.path.join(BASE_DIR, 'data')
JSON_DIR = os.path.join(DATA_DIR, 'json')
LOG_DIR = os.path.join(DATA_DIR, 'logs')

# Ensure data directories exist
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(JSON_DIR, exist_ok=True)
os.makedirs(LOG_DIR, exist_ok=True)

LOG_FILE = os.path.join(LOG_DIR, 'flask.log')
SYNC_STATUS_FILE = os.path.join(LOG_DIR, 'sync_status.log')

# Clear the log file each time the server starts
try:
    with open(LOG_FILE, 'w') as f:
        f.write('')
except IOError as e:
    print(f"Warning: Could not clear log file: {e}")

# Configure logging to file and console
file_handler = RotatingFileHandler(LOG_FILE, maxBytes=10*1024*1024, backupCount=5)
file_handler.setLevel(logging.DEBUG)
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s')
file_handler.setFormatter(formatter)
app.logger.addHandler(file_handler)
app.logger.setLevel(logging.DEBUG)

# Redirect stdout and stderr to the log file
class DualLogger:
    def __init__(self, filename, encoding='utf-8'):
        self.terminal = sys.stdout
        self.log = open(filename, 'a', encoding=encoding)

    def write(self, message):
        self.terminal.write(message)
        self.log.write(message)
        self.log.flush() # Ensure immediate write to file

    def flush(self):
        self.terminal.flush()
        self.log.flush()

sys.stdout = DualLogger(LOG_FILE)
sys.stderr = DualLogger(LOG_FILE)

# Log server startup
app.logger.info("Flask server starting up...")

# Initialize the connection pool
initialize_pool()
sync_controller = SyncController()

# Enable CORS for specific origins and methods
CORS(app, resources={r"/api/*": {"origins": "*"}},
     supports_credentials=True,
     methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
     headers=["Content-Type", "Authorization"])

# Thread lock for file operations
file_lock = threading.Lock()

def json_serial(obj):
    """JSON serializer for objects not serializable by default json code"""
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError("Type %s not serializable" % type(obj))

def write_json_file(file_path, data):
    """Helper function to write JSON data to a file safely."""
    with file_lock:
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=4, default=json_serial, ensure_ascii=False)
        except IOError as e:
            app.logger.error(f"Error writing to file {file_path}: {e}")

def get_products_data():
    """Load products with barcodes combined"""
    with file_lock:
        if not os.path.exists(PRODUCTS_FILE):
            return []
        try:
            with open(PRODUCTS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            app.logger.error(f"Error reading products file: {e}")
            return []

def save_products_data(products, change_type="INSERT"):
    """Save products with barcodes combined and queue individual items for sync"""
    write_json_file(PRODUCTS_FILE, products)

def get_users_data():
    """Load users with user stores combined"""
    with file_lock:
        if not os.path.exists(USERS_FILE):
            return []
        try:
            with open(USERS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            app.logger.error(f"Error reading users file: {e}")
            return []

def save_users_data(users, change_type="INSERT"):
    """Save users with user stores combined and queue individual items for sync"""
    write_json_file(USERS_FILE, users)

def get_bills_data():
    """Load bills with customers and bill items combined"""
    with file_lock:
        if not os.path.exists(BILLS_FILE):
            return []
        try:
            with open(BILLS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            app.logger.error(f"Error reading bills file: {e}")
            return []

def save_bills_data(bills, change_type="INSERT"):
    """Save bills with customers and bill items combined and queue individual items for sync"""
    write_json_file(BILLS_FILE, bills)

def get_customers_data():
    """Load customers data"""
    with file_lock:
        if not os.path.exists(CUSTOMERS_FILE):
            return []
        try:
            with open(CUSTOMERS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            app.logger.error(f"Error reading customers file: {e}")
            return []

def get_stores_data():
    """Load stores data"""
    with file_lock:
        if not os.path.exists(STORES_FILE):
            return []
        try:
            with open(STORES_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            app.logger.error(f"Error reading stores file: {e}")
            return []

def save_stores_data(stores, change_type="INSERT"):
    """Save stores data and queue individual items for sync"""
    write_json_file(STORES_FILE, stores)

def get_system_settings_data():
    """Load system settings"""
    with file_lock:
        if not os.path.exists(SYSTEM_SETTINGS_FILE):
            return {}
        try:
            with open(SYSTEM_SETTINGS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            app.logger.error(f"Error reading system settings file: {e}")
            return {}

def save_customers_data(customers, change_type="INSERT"):
    """Save customers data and queue individual items for sync"""
    write_json_file(CUSTOMERS_FILE, customers)

def save_system_settings_data(settings, change_type="UPDATE"):
    """Save system settings and queue for sync"""
    write_json_file(SYSTEM_SETTINGS_FILE, settings)

# Returns data helpers
def get_returns_data():
    with file_lock:
        if not os.path.exists(RETURNS_FILE):
            return []
        try:
            with open(RETURNS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            app.logger.error(f"Error reading returns file: {e}")
            return []

def save_returns_data(returns, change_type="INSERT"):
    write_json_file(RETURNS_FILE, returns)
    try:
        for return_item in returns[-10:]:
            if hasattr(sync_controller, 'queue_for_sync'):
                sync_controller.queue_for_sync('returns', return_item, change_type)
    except Exception as e:
        app.logger.error(f"Error queuing returns for sync: {e}")

def search_bills_for_returns(query, search_type):
    bills = get_bills_data()
    matching_bills = []
    query = query.lower().strip()
    for bill in bills:
        match_found = False
        if search_type == 'customer':
            customer_name = bill.get('customerName', '').lower()
            if query in customer_name:
                match_found = True
        elif search_type == 'phone':
            customer_phone = bill.get('customerPhone', '').lower()
            if query in customer_phone or query.replace(' ', '') in customer_phone.replace(' ', ''):
                match_found = True
        elif search_type == 'invoice':
            bill_id = bill.get('id', '').lower()
            if query in bill_id:
                match_found = True
        if match_found:
            matching_bills.append(bill)
    matching_bills.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
    return matching_bills

def log_sync_event(change_type: str, user_id: str | None = None, details: str | None = None):
    try:
        # Prefer ISO string; MySQL connector can also accept datetime if column is DATETIME
        payload = {
            'change_type': change_type,
            'timestamp': datetime.now().isoformat(),
            'user_id': user_id,
            'details': details
        }
        if hasattr(sync_controller, 'queue_for_sync'):
            # Will filter keys to actual sync_table columns and insert immediately
            sync_controller.queue_for_sync('sync_table', payload, 'INSERT')
        app.logger.info(f"Session event logged: {change_type} for user {user_id}")
    except Exception as e:
        app.logger.error(f"Failed to log session event: {e}")

def create_notification(notification_type, message, related_id=None):
    notification = {
        'id': str(uuid.uuid4()),
        'type': notification_type,
        'notification': message,
        'related_id': related_id,
        'is_read': False,
        'created_at': datetime.now().isoformat(),
        'updated_at': datetime.now().isoformat()
    }
    try:
        if hasattr(sync_controller, 'queue_for_sync'):
            sync_controller.queue_for_sync('notifications', notification, 'INSERT')
    except Exception as e:
        app.logger.error(f"Error queuing notification for sync: {e}")
    app.logger.info(f"Created notification: {notification_type} - {message}")
    return notification

# API endpoints

@app.route('/api/returns/search', methods=['POST'])
def search_bills_for_returns_api():
    try:
        data = request.json
        if not data:
            return jsonify({"error": "Request data is required"}), 400
        query = data.get('query', '').strip()
        search_type = data.get('searchType', 'customer')
        if not query:
            return jsonify({"error": "Search query is required"}), 400
        if search_type not in ['customer', 'phone', 'invoice']:
            return jsonify({"error": "Invalid search type"}), 400
        results = search_bills_for_returns(query, search_type)
        app.logger.info(f"Returns search: {search_type}='{query}' found {len(results)} bills")
        return jsonify(results), 200
    except Exception as e:
        app.logger.error(f"Error searching bills for returns: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@app.route('/api/returns/submit', methods=['POST'])
def submit_return_request():
    try:
        data = request.json
        if not data:
            return jsonify({"error": "Request data is required"}), 400
        selected_items = data.get('selectedItems', [])
        return_reason = data.get('returnReason', '').strip()
        refund_method = data.get('refundMethod', 'cash')
        search_results = data.get('searchResults', [])
        created_by = data.get('createdBy', 'Unknown')
        if not selected_items:
            return jsonify({"error": "No items selected for return"}), 400
        if not return_reason:
            return jsonify({"error": "Return reason is required"}), 400
        existing_returns = get_returns_data()
        new_returns = []
        total_return_amount = 0
        for item_id in selected_items:
            try:
                bill_id, item_index = item_id.split('-')
                item_index = int(item_index)
                bill = next((b for b in search_results if b['id'] == bill_id), None)
                if not bill or item_index >= len(bill['items']):
                    app.logger.warning(f"Could not find bill or item for {item_id}")
                    continue
                item = bill['items'][item_index]
                return_id = str(uuid.uuid4())
                return_record = {
                    'return_id': return_id,
                    'product_name': item['productName'],
                    'product_id': item.get('productId', ''),
                    'customer_name': bill.get('customerName', ''),
                    'customer_phone_number': bill.get('customerPhone', ''),
                    'message': return_reason,
                    'refund_method': refund_method,
                    'bill_id': bill_id,
                    'item_index': item_index,
                    'return_amount': float(item['total']),
                    'status': 'pending',
                    'created_by': created_by,
                    'created_at': datetime.now().isoformat(),
                    'updated_at': datetime.now().isoformat()
                }
                new_returns.append(return_record)
                total_return_amount += float(item['total'])
            except Exception as e:
                app.logger.error(f"Error processing return item {item_id}: {e}")
                continue
        if not new_returns:
            return jsonify({"error": "No valid items found for return"}), 400
        existing_returns.extend(new_returns)
        save_returns_data(existing_returns)
        notification_message = f"New return request submitted by {created_by}. {len(new_returns)} item(s) for ₹{total_return_amount:.2f}"
        create_notification('return_request', notification_message, new_returns[0]['return_id'])
        app.logger.info(f"Return request submitted: {len(new_returns)} items, total: ₹{total_return_amount:.2f}")
        return jsonify({
            "message": "Return request submitted successfully",
            "returnId": new_returns[0]['return_id'],
            "itemCount": len(new_returns),
            "totalAmount": total_return_amount
        }), 200
    except Exception as e:
        app.logger.error(f"Error submitting return request: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@app.route('/api/sync/push', methods=['POST'])
def api_push_sync():
    """Endpoint for apps to push unsynced data to the backend."""
    try:
        sync_data = request.json
        if not sync_data:
            return jsonify({"error": "No sync data provided"}), 400

        result = sync_controller.push_sync(sync_data)
        if result['success']:
            return jsonify(result), 200
        else:
            return jsonify({"error": "Push sync failed", "details": result['errors']}), 500

    except Exception as e:
        app.logger.error(f"Error in /api/sync/push: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@app.route('/api/sync/pull', methods=['POST'])
def api_pull_sync():
    """Endpoint for apps to pull updated data from the backend."""
    try:
        request_data = request.json or {}
        last_sync_timestamp = request_data.get('last_sync')
        tables_to_pull = request_data.get('tables')  # Optional: list of tables to pull

        result = sync_controller.pull_sync(last_sync_timestamp, tables_to_pull)
        if result['success']:
            return jsonify(result), 200
        else:
            return jsonify({"error": "Pull sync failed", "details": result['errors']}), 500

    except Exception as e:
        app.logger.error(f"Error in /api/sync/pull: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@app.route('/api/sync/status', methods=['GET'])
def api_sync_status():
    """Endpoint to get the current status of the sync system."""
    try:
        status = sync_controller.get_sync_status()
        return jsonify(status), 200
    except Exception as e:
        app.logger.error(f"Error in /api/sync/status: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@app.route('/api/test-env', methods=['GET'])
def test_env():
    """Test environment variables"""
    return jsonify({
        'MYSQL_HOST': os.getenv('MYSQL_HOST'),
        'MYSQL_USER': os.getenv('MYSQL_USER'),
        'MYSQL_PASSWORD': '***' if os.getenv('MYSQL_PASSWORD') else None,  # Hide password
        'MYSQL_DATABASE': os.getenv('MYSQL_DATABASE'),
        'has_dotenv': True if os.getenv('MYSQL_HOST') else False
    })

@app.route('/api/auth/login', methods=['POST'])
def login():
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
            # Log a LOGIN event into sync_table
            log_sync_event('LOGIN', user_info.get('id'), 'User logged in')
            return jsonify({
                "auth_ok": True, 
                "user_role": user_info.get('role'), 
                "user": user_info, 
                "message": "Login successful"
            })

        return jsonify({"message": "Invalid email or password"}), 401

    except Exception as e:
        app.logger.error(f"Login error: {e}")
        return jsonify({"message": f"Server error: {str(e)}"}), 500

@app.route('/api/auth/login', methods=['OPTIONS'])
def login_options():
    response = make_response()
    response.headers.add("Access-Control-Allow-Origin", "*")
    response.headers.add("Access-Control-Allow-Methods", "POST, OPTIONS")
    response.headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
    return response, 200

@app.route('/api/auth/logout', methods=['POST'])
def logout():
    try:
        data = request.json or {}
        # Accept any identifier the client can provide
        user_id = data.get('userId') or data.get('id') or data.get('email')
        log_sync_event('LOGOUT', user_id, 'User explicitly logged out')
        return jsonify({"message": "Logout recorded"}), 200
    except Exception as e:
        app.logger.error(f"Logout error: {e}")
        return jsonify({"message": f"Server error: {str(e)}"}), 500

@app.route('/api/auth/close', methods=['POST'])
def app_closed_without_logout():
    try:
        data = request.json or {}
        user_id = data.get('userId') or data.get('id') or data.get('email')
        log_sync_event('CLOSE_NO_LOGOUT', user_id, 'App closed without explicit logout')
        return jsonify({"message": "Close recorded"}), 200
    except Exception as e:
        app.logger.error(f"Close log error: {e}")
        return jsonify({"message": f"Server error: {str(e)}"}), 500

@app.route('/api/auth/forgot-password-proxy', methods=['POST'])
def forgot_password_proxy():
    try:
        data = request.json
        if not data:
            return jsonify({"message": "Request body is required"}), 400
            
        email = data.get('email')
        if not email:
            return jsonify({"message": "Email is required"}), 400

        users = get_users_data()
        user = next((u for u in users if u.get('email', '').lower() == email.lower()), None)

        # For security, always return a generic message whether the email exists or not
        if user:
            app.logger.info(f"Password reset requested for email: {email}. (Simulated email sent)")
        else:
            app.logger.warning(f"Password reset requested for non-existent email: {email}")
            
        return jsonify({"message": "If an account with that email exists, a password reset link has been sent."}), 200

    except Exception as e:
        app.logger.error(f"Forgot password error: {e}")
        return jsonify({"message": f"Server error: {str(e)}"}), 500

@app.route('/api/products', methods=['GET'])
def get_products():
    try:
        products = get_products_data()
        return jsonify(products), 200
    except Exception as e:
        app.logger.error(f"Error getting products: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@app.route('/api/products/upload', methods=['POST'])
def upload_products():
    try:
        products_to_upload = request.json
        if not isinstance(products_to_upload, list):
            return jsonify({"error": "Expected a list of products"}), 400

        existing_products = get_products_data()
        updated_products = []
        for new_product in products_to_upload:
            # Check if product with same ID or barcode exists
            existing_index = -1
            if 'id' in new_product:
                existing_index = next((i for i, p in enumerate(existing_products) if p.get('id') == new_product['id']), -1)
            if existing_index == -1 and 'barcodes' in new_product:
                existing_index = next((i for i, p in enumerate(existing_products) if p.get('barcodes') and any(b in p['barcodes'].split(',') for b in new_product['barcodes'].split(','))), -1)

            if existing_index != -1:
                # Update existing product
                existing_products[existing_index] = {**existing_products[existing_index], **new_product}
            else:
                # Add new product
                if 'id' not in new_product:
                    new_product['id'] = str(uuid.uuid4()) # Generate UUID if not provided
                existing_products.append(new_product)
        
        save_products_data(existing_products)
        return jsonify({"message": "Products uploaded successfully", "count": len(products_to_upload)}), 200
    except Exception as e:
        app.logger.error(f"Error uploading products: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@app.route('/api/users', methods=['GET'])
def get_users():
    try:
        users = get_users_data()
        return jsonify({"users": users}), 200
    except Exception as e:
        app.logger.error(f"Error getting users: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@app.route('/api/stores', methods=['GET'])
def get_stores():
    try:
        stores = get_stores_data()
        return jsonify({"stores": stores}), 200
    except Exception as e:
        app.logger.error(f"Error getting stores: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@app.route('/api/user-stores', methods=['GET'])
def get_user_stores():
    try:
        # Assuming user-store mappings are part of user data or a separate file
        # For now, let's return a dummy or derive from users if possible
        users = get_users_data()
        user_stores = []
        for user in users:
            if 'storeId' in user: # Assuming user object has a storeId
                user_stores.append({"userId": user['id'], "storeId": user['storeId']})
        return jsonify(user_stores), 200
    except Exception as e:
        app.logger.error(f"Error getting user stores: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@app.route('/api/settings', methods=['GET'])
def get_settings():
    try:
        settings = get_system_settings_data()
        return jsonify(settings), 200
    except Exception as e:
        app.logger.error(f"Error getting settings: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@app.route('/api/billing/save', methods=['POST'])
def save_bill():
    try:
        bill_data = request.json
        if not bill_data:
            return jsonify({"error": "No bill data provided"}), 400

        bills = get_bills_data()
        bills.append(bill_data)
        save_bills_data(bills) # This will also queue for sync

        return jsonify({"message": "Bill saved successfully", "billId": bill_data.get('id')}), 200
    except Exception as e:
        app.logger.error(f"Error saving bill: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@app.route('/api/bills', methods=['GET'])
def get_bills():
    try:
        bills = get_bills_data()
        return jsonify(bills), 200
    except Exception as e:
        app.logger.error(f"Error getting bills: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

def background_pull_sync_scheduler(interval_minutes=5):
    """Periodically pulls updates from MySQL using the SyncController."""
    while True:
        app.logger.info(f"Background pull sync starting. Next sync in {interval_minutes} minutes.")
        try:
            result = sync_controller.pull_sync(last_sync=None)
            if result['success']:
                app.logger.info("Background pull sync completed successfully.")
            else:
                app.logger.error(f"Background pull sync failed: {result['errors']}")
        except Exception as e:
            app.logger.error(f"Error during background pull sync: {e}")
        
        time.sleep(interval_minutes * 60)

if __name__ == '__main__':
    app.logger.info("Flask server starting...")
    
    backend_api_url = os.environ.get('NEXT_PUBLIC_BACKEND_API_URL', 'http://127.0.0.1:8080')
    parsed_url = urlparse(backend_api_url)
    port = parsed_url.port if parsed_url.port else 8080
    
    app.logger.info(f"Flask will run on port {port}")
    
    # Start the background pull sync scheduler in a separate daemon thread
    pull_scheduler_thread = threading.Thread(target=background_pull_sync_scheduler, daemon=True)
    pull_scheduler_thread.start()

    try:
        app.run(debug=True, port=port)
    except Exception as e:
        app.logger.error(f"Failed to start Flask server: {e}")
    finally:
        close_pool()  # Ensure pool is closed on app shutdown
