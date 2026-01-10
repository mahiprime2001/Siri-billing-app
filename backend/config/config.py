import os
import sys
from datetime import datetime

# =========================================================
# 🔒 SAFE BASE DIRECTORY (PyInstaller + Dev Compatible)
# =========================================================

def get_app_root():
    """
    Returns a writable application root directory.
    - When frozen (PyInstaller): folder containing the EXE
    - When running normally: project root
    """
    if getattr(sys, 'frozen', False):
        # PyInstaller EXE directory
        return os.path.dirname(sys.executable)
    else:
        # Normal Python execution
        return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

APP_ROOT = get_app_root()

# =========================================================
# 📁 DATA DIRECTORIES
# =========================================================

DATA_DIR = os.path.join(APP_ROOT, 'data')
JSON_DIR = os.path.join(DATA_DIR, 'json')
LOGS_DIR = os.path.join(DATA_DIR, 'logs')

# Create required directories
os.makedirs(JSON_DIR, exist_ok=True)
os.makedirs(LOGS_DIR, exist_ok=True)

# =========================================================
# 📄 JSON FILE PATHS
# =========================================================

USERS_FILE = os.path.join(JSON_DIR, "users.json")
PRODUCTS_FILE = os.path.join(JSON_DIR, "products.json")
BILLS_FILE = os.path.join(JSON_DIR, "bills.json")
CUSTOMERS_FILE = os.path.join(JSON_DIR, "customers.json")
SYSTEM_SETTINGS_FILE = os.path.join(JSON_DIR, "system_settings.json")
STORES_FILE = os.path.join(JSON_DIR, "stores.json")
RETURNS_FILE = os.path.join(JSON_DIR, "returns.json")
BILL_FORMATS_FILE = os.path.join(JSON_DIR, "bill_formats.json")
USER_STORES_FILE = os.path.join(JSON_DIR, "userstores.json")

# =========================================================
# 📝 LOGGING
# =========================================================

def get_log_file_path():
    """Generate log file path with current date"""
    today = datetime.now().strftime("%Y-%m-%d")
    return os.path.join(LOGS_DIR, f"billing_app-{today}.log")

LOG_FILE = get_log_file_path()

# =========================================================
# 🧹 LOG RETENTION
# =========================================================

LOG_RETENTION_DAYS = 30  # Delete logs older than 30 days
