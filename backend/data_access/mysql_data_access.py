from datetime import datetime, date
from decimal import Decimal
from flask import current_app as app

from utils.connection_pool import get_connection
from utils.sync_controller import SyncController

sync_controller = SyncController()

def sync_to_mysql_immediately(table_name, record, operation="INSERT"):
    """
    Immediately sync a record to MySQL without queuing.
    Returns True if successful, False otherwise.
    """
    try:
        result = sync_controller.queue_for_sync(table_name, record, operation)
        if result:
            app.logger.info(f"Successfully synced {operation} for {table_name}: {record.get('id')}")
            return True
        else:
            app.logger.warning(f"Failed to sync {operation} for {table_name}: {record.get('id')}")
            return False
    except Exception as e:
        app.logger.error(f"Error syncing {table_name} to MySQL: {e}")
        return False

def get_mysql_data(table_name, where_clause=None, params=None):
    """Fetch data directly from MySQL with optional WHERE clause"""
    connection = None
    try:
        connection = get_connection()
        if not connection:
            return None
        
        cursor = connection.cursor(dictionary=True)
        if table_name == 'Products':
            query = "SELECT id, name, stock, assignedStoreId, batchId, selling_price, createdAt, updatedAt FROM Products"
        else:
            query = f"SELECT * FROM {table_name}"
        
        if where_clause:
            query += f" WHERE {where_clause}"
        
        if params:
            cursor.execute(query, params)
        else:
            cursor.execute(query)
        
        results = cursor.fetchall()
        
        # Convert to JSON-serializable
        serialized_results = []
        for record in results:
            serialized_record = {}
            for key, value in record.items():
                if isinstance(value, (datetime, date)):
                    serialized_record[key] = value.isoformat()
                elif isinstance(value, Decimal):
                    serialized_record[key] = float(value)
                else:
                    serialized_record[key] = value
            serialized_results.append(serialized_record)
        
        return serialized_results
    
    except Exception as e:
        app.logger.error(f"Error fetching from MySQL {table_name}: {e}")
        return None
    finally:
        if connection:
            connection.close()

def check_user_exists_mysql(user_id):
    """Check if a user exists in MySQL"""
    result = get_mysql_data('Users', 'id = %s', (user_id,))
    return result is not None and len(result) > 0

def check_customer_exists_mysql(customer_id):
    """Check if a customer exists in MySQL"""
    result = get_mysql_data('Customers', 'id = %s', (customer_id,))
    return result is not None and len(result) > 0

def check_product_exists_mysql(product_id):
    """Check if a product exists in MySQL"""
    result = get_mysql_data('Products', 'id = %s', (product_id,))
    return result is not None and len(result) > 0

def get_product_barcodes_mysql(product_id):
    """Get all barcodes for a product from ProductBarcodes table"""
    result = get_mysql_data('ProductBarcodes', 'productId = %s', (product_id,))
    if result:
        return [r['barcode'] for r in result]
    return []
