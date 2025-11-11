from config.config import (
    USERS_FILE, PRODUCTS_FILE, BILLS_FILE, CUSTOMERS_FILE,
    SYSTEM_SETTINGS_FILE, STORES_FILE, RETURNS_FILE
)
from helpers.utils import read_json_file, write_json_file
from data_access.mysql_data_access import (
    get_mysql_data, sync_to_mysql_immediately, get_product_barcodes_mysql
)

def get_products_data():
    """Load products from MySQL first, fallback to JSON"""
    mysql_data = get_mysql_data('Products')
    if mysql_data is not None:
        # Enrich with barcodes from ProductBarcodes table
        for product in mysql_data:
            barcodes = get_product_barcodes_mysql(product['id'])
            product['barcodes'] = ','.join(barcodes) if barcodes else ''
            
        return mysql_data
    return read_json_file(PRODUCTS_FILE, [])

def save_products_data(products):
    """Save products to both MySQL and JSON"""
    write_json_file(PRODUCTS_FILE, products)
    # Sync each product
    for product in products:
        sync_to_mysql_immediately('Products', product, "UPDATE")

def get_users_data():
    """Load users from MySQL first, fallback to JSON"""
    mysql_data = get_mysql_data('Users')
    if mysql_data is not None:
        # Filter out super_admin users
        return [user for user in mysql_data if user.get('role') != 'super_admin']
    
    json_data = read_json_file(USERS_FILE, [])
    # Filter out super_admin users from JSON data as well
    return [user for user in json_data if user.get('role') != 'super_admin']

def get_bills_data():
    """Load bills from JSON (bills are primarily created here)"""
    return read_json_file(BILLS_FILE, [])

def save_bills_data(bills):
    """Save bills to JSON and sync to MySQL"""
    write_json_file(BILLS_FILE, bills)

def get_customers_data():
    """Load customers from MySQL first, fallback to JSON"""
    mysql_data = get_mysql_data('Customers')
    if mysql_data is not None:
        return mysql_data
    return read_json_file(CUSTOMERS_FILE, [])

def save_customers_data(customers):
    """Save customers to both MySQL and JSON"""
    write_json_file(CUSTOMERS_FILE, customers)

def get_stores_data():
    """Load stores from MySQL first, fallback to JSON"""
    mysql_data = get_mysql_data('Stores')
    if mysql_data is not None:
        return mysql_data
    return read_json_file(STORES_FILE, [])

def get_system_settings_data():
    """Load system settings from MySQL first, fallback to JSON"""
    mysql_data = get_mysql_data('SystemSettings')
    if mysql_data is not None and len(mysql_data) > 0:
        return mysql_data[0]  # Return first settings record
    return read_json_file(SYSTEM_SETTINGS_FILE, {})

def get_returns_data():
    """Load returns from MySQL first, fallback to JSON"""
    mysql_data = get_mysql_data('Returns')
    if mysql_data is not None:
        return mysql_data
    return read_json_file(RETURNS_FILE, [])

def save_returns_data(returns):
    """Save returns to JSON and sync to MySQL"""
    write_json_file(RETURNS_FILE, returns)
    # Sync recent returns
    for return_item in returns[-10:]:
        sync_to_mysql_immediately('Returns', return_item, "INSERT")
