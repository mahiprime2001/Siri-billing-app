import os
from dotenv import load_dotenv

# Define base directories
APP_BASE_DIR = os.getcwd()
os.environ['APP_BASE_DIR'] = APP_BASE_DIR

DOTENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env')
load_dotenv(dotenv_path=DOTENV_PATH)

# Data directories
DATA_DIR = os.path.join(APP_BASE_DIR, 'data')
JSON_DIR = os.path.join(DATA_DIR, 'json')
LOG_DIR = os.path.join(DATA_DIR, 'logs')

# JSON file paths (local fallback storage)
USERS_FILE = os.path.join(JSON_DIR, 'users.json')
PRODUCTS_FILE = os.path.join(JSON_DIR, 'products.json')
BILLS_FILE = os.path.join(JSON_DIR, 'bills.json')
CUSTOMERS_FILE = os.path.join(JSON_DIR, 'customers.json')
SYSTEM_SETTINGS_FILE = os.path.join(JSON_DIR, 'systemsettings.json')
STORES_FILE = os.path.join(JSON_DIR, 'stores.json')
BILL_FORMATS_FILE = os.path.join(JSON_DIR, 'billformats.json')
RETURNS_FILE = os.path.join(JSON_DIR, 'returns.json')

# Ensure directories exist
os.makedirs(JSON_DIR, exist_ok=True)
os.makedirs(LOG_DIR, exist_ok=True)

LOG_FILE = os.path.join(LOG_DIR, 'billing_flask.log')
SYNC_STATUS_FILE = os.path.join(LOG_DIR, 'billing_sync_status.log')
