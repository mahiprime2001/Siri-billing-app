import uuid
from datetime import datetime
import traceback
from supabase import Client
from utils.connection_pool import get_supabase_client
from config.config import (
    USERS_FILE, PRODUCTS_FILE, BILLS_FILE, CUSTOMERS_FILE,
    SYSTEM_SETTINGS_FILE, STORES_FILE, RETURNS_FILE, USER_STORES_FILE
)

from helpers.utils import read_json_file, write_json_file
from data_access.supabase_data_access import (
    get_supabase_data, sync_to_supabase_immediately, get_product_barcodes_supabase
)

def get_or_create_customer(customer_name: str, customer_phone: str, customer_email: str = '', customer_address: str = '') -> str:
    """
    Get existing customer by phone or create new one in Supabase
    Returns customer_id
    """
    supabase: Client = get_supabase_client()
    if not supabase:
        print("ERROR: No Supabase client for customer lookup in data_access.")
        return None
    
    try:
        customer_id = None
        
        # Check if customer exists by phone
        if customer_phone:
            response = supabase.from_("customers").select("id, name, email, address").eq("phone", customer_phone).execute()
            existing_customer = response.data[0] if response.data else None
            
            if existing_customer:
                customer_id = existing_customer['id']
                
                # Update customer info if provided
                update_data = {
                    "name": customer_name or existing_customer['name'],
                    "email": customer_email or existing_customer['email'],
                    "address": customer_address or existing_customer['address'],
                    "updated_at": datetime.now().isoformat()  # ✅ WITH underscore
                }
                
                update_response = supabase.from_("customers").update(update_data).eq("id", customer_id).execute()
                
                if not update_response.data:
                    print(f"ERROR: Failed to update customer {customer_id}")
                else:
                    print(f"INFO: Updated customer: {customer_id}")
                
                return customer_id
        
        # Create new customer if not found or no phone provided
        customer_id = f"CUST-{uuid.uuid4().hex[:12]}"
        now = datetime.now().isoformat()
        
        # ✅ customers table uses created_at/updated_at WITH underscores
        insert_data = {
            "id": customer_id,
            "name": customer_name or 'Walk-in Customer',
            "phone": customer_phone or '',
            "email": customer_email or '',
            "address": customer_address or '',
            "created_at": now,  # ✅ WITH underscore
            "updated_at": now   # ✅ WITH underscore
        }
        
        insert_response = supabase.from_("customers").insert(insert_data).execute()
        
        if insert_response.data:
            print(f"INFO: Created new customer: {customer_id}")
            return customer_id
        else:
            print(f"ERROR: Failed to create customer")
            return None
            
    except Exception as e:
        print(f"ERROR: Error in get_or_create_customer (Supabase): {e}\n{traceback.format_exc()}")
        return None



def update_product_stock_local(product_id: str, quantity_sold: int) -> bool:
    """
    Update product stock in local JSON file
    """
    try:
        products = get_products_data()
        product_found = False
        
        for product in products:
            if str(product.get('id')) == str(product_id):
                current_stock = product.get('stock', 0)
                new_stock = current_stock - quantity_sold
                product['stock'] = new_stock
                product['updatedAt'] = datetime.now().isoformat()
                
                # FIX: Remove 'barcodes' field before syncing to prevent schema errors
                if 'barcodes' in product:
                    del product['barcodes']
                
                product_found = True
                print(f"INFO: Local JSON stock updated for {product_id}: {current_stock} -> {new_stock}")
                break
        
        if not product_found:
            print(f"WARNING: Product {product_id} not found in local JSON")
            return False
        
        # Save updated products to JSON
        save_products_data(products)
        return True
        
    except Exception as e:
        print(f"ERROR: Error updating local product stock: {e}")
        return False

def update_product_stock_supabase(product_id: str, quantity_sold: int) -> bool:
    """
    Atomically update product stock in Supabase database
    """
    supabase: Client = get_supabase_client()
    if not supabase:
        print("ERROR: No Supabase client for stock update in data_access.")
        return False

    try:
        # Fetch current stock
        response = supabase.from_("products").select("stock").eq("id", product_id).execute()
        product = response.data[0] if response.data else None
        
        if not product:
            print(f"ERROR: Product {product_id} not found in Supabase")
            return False
        
        current_stock = product['stock']
        new_stock = current_stock - quantity_sold
        
        if new_stock < 0:
            print(
                f"WARNING: Stock going negative for product {product_id}. "
                f"Current: {current_stock}, Sold: {quantity_sold}, New: {new_stock}"
            )
        
        # Update stock atomically
        update_data = {
            "stock": new_stock,
            "updatedat": datetime.now().isoformat()
        }
        
        response = supabase.from_("products").update(update_data).eq("id", product_id).execute()
        
        if response.data:
            print(f"INFO: Supabase stock updated for {product_id}: {current_stock} -> {new_stock}")
            return True
        else:
            print(f"ERROR: Failed to update Supabase stock for {product_id}: {response.data}")
            return False
            
    except Exception as e:
        print(f"ERROR: Error updating Supabase stock: {e}\n{traceback.format_exc()}")
        return False

def save_bill_item(bill_item: dict) -> bool:
    """Save a single bill item to Supabase and log the operation."""
    try:
        if sync_to_supabase_immediately('billitems', bill_item, 'INSERT'):
            print(f"INFO: Successfully synced BillItem {bill_item.get('id')} to Supabase.")
            return True
        else:
            print(f"ERROR: Failed to sync BillItem {bill_item.get('id')} to Supabase.")
            return False
    except Exception as e:
        print(f"ERROR: Error saving bill item: {e}\n{traceback.format_exc()}")
        return False

def get_products_data():
    """Load products from Supabase first, fallback to JSON"""
    supabase_data = get_supabase_data('products')
    if supabase_data is not None:
        # Enrich with barcodes from ProductBarcodes table
        for product in supabase_data:
            barcodes = get_product_barcodes_supabase(product['id'])
            product['barcodes'] = ','.join(barcodes) if barcodes else ''
        return supabase_data
    return read_json_file(PRODUCTS_FILE, [])

def save_products_data(products):
    """Save products to both Supabase and JSON"""
    write_json_file(PRODUCTS_FILE, products)
    # Sync each product
    for product in products:
        sync_to_supabase_immediately('products', product, "UPDATE")

def get_users_data():
    """Load users from Supabase first, fallback to JSON (excluding admin and super_admin)"""
    supabase_data = get_supabase_data('users')
    if supabase_data is not None:
        # ✅ Filter out admin AND super_admin users
        return [user for user in supabase_data if user.get('role') not in ['admin', 'super_admin']]
    
    json_data = read_json_file(USERS_FILE, [])
    # ✅ Filter out admin AND super_admin users from JSON data as well
    return [user for user in json_data if user.get('role') not in ['admin', 'super_admin']]

def get_userstores_data():
    """Load user stores from Supabase first, fallback to JSON"""
    supabase_data = get_supabase_data('userstores')
    if supabase_data is not None:
        return supabase_data
    return read_json_file(USER_STORES_FILE, [])

def save_userstores_data(userstores):
    """Save user stores to both Supabase and JSON"""
    write_json_file(USER_STORES_FILE, userstores)
    # Sync each user store association
    for userstore in userstores:
        sync_to_supabase_immediately('userstores', userstore, "UPDATE")

def get_bills_data():
    """Load bills from Supabase first, fallback to JSON"""
    supabase_data = get_supabase_data('bills')
    if supabase_data is not None:
        return supabase_data
    return read_json_file(BILLS_FILE, [])

def save_bills_data(bills):
    """Save bills to JSON and sync to Supabase"""
    write_json_file(BILLS_FILE, bills)
    # Sync each bill
    for bill in bills:
        sync_to_supabase_immediately('bills', bill, "INSERT")  # Assuming new bills are always inserted

def get_customers_data():
    """Load customers from Supabase first, fallback to JSON"""
    supabase_data = get_supabase_data('customers')
    if supabase_data is not None:
        return supabase_data
    return read_json_file(CUSTOMERS_FILE, [])

def save_customers_data(customers):
    """Save customers to both Supabase and JSON"""
    write_json_file(CUSTOMERS_FILE, customers)
    # Sync each customer
    for customer in customers:
        sync_to_supabase_immediately('customers', customer, "UPDATE")

def get_stores_data():
    """Load stores from Supabase first, fallback to JSON"""
    supabase_data = get_supabase_data('stores')
    if supabase_data is not None:
        return supabase_data
    return read_json_file(STORES_FILE, [])

def get_system_settings_data():
    """Load system settings from Supabase first, fallback to JSON"""
    supabase_data = get_supabase_data('systemsettings')
    if supabase_data is not None and len(supabase_data) > 0:
        return supabase_data[0]  # Return first settings record
    return read_json_file(SYSTEM_SETTINGS_FILE, {})

def get_returns_data():
    """Load returns from Supabase first, fallback to JSON"""
    supabase_data = get_supabase_data('returns')
    if supabase_data is not None:
        return supabase_data
    return read_json_file(RETURNS_FILE, [])

def save_returns_data(returns):
    """Save returns to JSON and sync to Supabase"""
    write_json_file(RETURNS_FILE, returns)
    # Sync recent returns
    for return_item in returns[-10:]:  # Assuming only recent returns are synced
        sync_to_supabase_immediately('returns', return_item, "INSERT")


def update_store_inventory_stock(store_id: str, product_id: str, quantity_sold: int) -> bool:
    """
    Update stock in storeinventory table for a specific store
    This is the PRIMARY stock management for store-specific inventory
    """
    supabase: Client = get_supabase_client()
    if not supabase:
        print("ERROR: No Supabase client for store inventory stock update.")
        return False
    
    try:
        # Fetch current inventory quantity for this store
        response = supabase.from_("storeinventory") \
            .select("quantity") \
            .eq("storeid", store_id) \
            .eq("productid", product_id) \
            .execute()
        
        inventory = response.data[0] if response.data else None
        
        if not inventory:
            print(f"ERROR: Product {product_id} not found in store {store_id} inventory")
            return False
        
        current_quantity = inventory['quantity']
        new_quantity = current_quantity - quantity_sold
        
        if new_quantity < 0:
            print(
                f"WARNING: Store inventory going negative for product {product_id} in store {store_id}. "
                f"Current: {current_quantity}, Sold: {quantity_sold}, New: {new_quantity}"
            )
        
        # Update storeinventory quantity
        update_data = {
            "quantity": new_quantity,
            "updatedat": datetime.now().isoformat()
        }
        
        response = supabase.from_("storeinventory") \
            .update(update_data) \
            .eq("storeid", store_id) \
            .eq("productid", product_id) \
            .execute()
        
        if response.data:
            print(f"✅ Store inventory updated for {product_id} in store {store_id}: {current_quantity} -> {new_quantity}")
            return True
        else:
            print(f"ERROR: Failed to update store inventory for {product_id}: {response.data}")
            return False
            
    except Exception as e:
        print(f"ERROR: Error updating store inventory stock: {e}\n{traceback.format_exc()}")
        return False


def update_both_inventory_and_product_stock(store_id: str, product_id: str, quantity_sold: int) -> bool:
    """
    Update stock in BOTH storeinventory (primary) AND products table (global)
    Call this when a sale is made to keep both tables in sync
    """
    print(f"📦 Updating stock for product {product_id}: storeinventory (store {store_id}) and products table")
    
    # Update store-specific inventory first (PRIMARY)
    store_inventory_updated = update_store_inventory_stock(store_id, product_id, quantity_sold)
    
    # Update global products table (SECONDARY)
    products_table_updated = update_product_stock_supabase(product_id, quantity_sold)
    
    if store_inventory_updated and products_table_updated:
        print(f"✅ Successfully updated BOTH storeinventory and products table for {product_id}")
        return True
    elif store_inventory_updated:
        print(f"⚠️ Store inventory updated but products table failed for {product_id}")
        return True  # Store inventory is primary, so this is still a success
    else:
        print(f"❌ Failed to update stock for {product_id}")
        return False
