import os
from datetime import datetime

# Define the base data directory path
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')

# ✅ NEW: Subdirectories for organized storage
JSON_DIR = os.path.join(DATA_DIR, 'json')
LOGS_DIR = os.path.join(DATA_DIR, 'logs')

# ✅ Create directory structure
os.makedirs(JSON_DIR, exist_ok=True)
os.makedirs(LOGS_DIR, exist_ok=True)

# ✅ UPDATED: JSON files now in data/json/
USERS_FILE = os.path.join(JSON_DIR, "users.json")
PRODUCTS_FILE = os.path.join(JSON_DIR, "products.json")
BILLS_FILE = os.path.join(JSON_DIR, "bills.json")
CUSTOMERS_FILE = os.path.join(JSON_DIR, "customers.json")
SYSTEM_SETTINGS_FILE = os.path.join(JSON_DIR, "system_settings.json")
STORES_FILE = os.path.join(JSON_DIR, "stores.json")
RETURNS_FILE = os.path.join(JSON_DIR, "returns.json")
BILL_FORMATS_FILE = os.path.join(JSON_DIR, "bill_formats.json")
USER_STORES_FILE = os.path.join(JSON_DIR, "userstores.json")

# ✅ UPDATED: Log file now in data/logs/ with date suffix
def get_log_file_path():
    """Generate log file path with current date"""
    today = datetime.now().strftime("%Y-%m-%d")
    return os.path.join(LOGS_DIR, f"billing_app-{today}.log")

LOG_FILE = get_log_file_path()

# ✅ NEW: Log retention settings
LOG_RETENTION_DAYS = 30  # Delete logs older than 30 days
