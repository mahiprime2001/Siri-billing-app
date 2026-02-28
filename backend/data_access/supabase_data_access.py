import logging
from supabase import Client
from typing import List, Dict, Any, Optional
from utils.connection_pool import get_supabase_client
from utils.sync_controller import SyncController  # Keep this for now, will be refactored later
from helpers.utils import read_json_file, write_json_file
from config.config import (
    USERS_FILE,
    PRODUCTS_FILE,
    BILLS_FILE,
    CUSTOMERS_FILE,
    SYSTEM_SETTINGS_FILE,
    STORES_FILE,
    RETURNS_FILE,
    STORE_DAMAGE_RETURNS_FILE,
    USER_STORES_FILE,
    HSN_CODES_FILE,
)

logger = logging.getLogger('supabase_data_access')

# Placeholder SyncController for now, will be properly integrated/refactored

TABLE_CACHE_FILES = {
    "users": USERS_FILE,
    "products": PRODUCTS_FILE,
    "bills": BILLS_FILE,
    "customers": CUSTOMERS_FILE,
    "systemsettings": SYSTEM_SETTINGS_FILE,
    "stores": STORES_FILE,
    "returns": RETURNS_FILE,
    "store_damage_returns": STORE_DAMAGE_RETURNS_FILE,
    "userstores": USER_STORES_FILE,
    "hsn_codes": HSN_CODES_FILE,
}


def _read_local_cache(table_name: str) -> Optional[List[Dict]]:
    cache_file = TABLE_CACHE_FILES.get(table_name.lower())
    if not cache_file:
        return None
    default = {} if table_name.lower() == "systemsettings" else []
    data = read_json_file(cache_file, default)
    if isinstance(data, dict):
        return [data]
    if isinstance(data, list):
        return data
    return []


def _refresh_local_cache(table_name: str, records: List[Dict]) -> None:
    cache_file = TABLE_CACHE_FILES.get(table_name.lower())
    if not cache_file:
        return
    if table_name.lower() == "systemsettings":
        write_json_file(cache_file, records[0] if records else {})
    else:
        write_json_file(cache_file, records)

def sync_to_supabase_immediately(table_name: str, record: Dict, operation: str = "INSERT") -> bool:
    """
    Immediately sync a record to Supabase using SyncController's queue_for_sync.
    Handles INSERT and UPDATE operations via SyncController for consistency and validation.
    DELETE operations are handled directly here as queue_for_sync does not support them.
    """
    logger.info(f"Attempting immediate sync for {operation} on {table_name}: {record.get('id')}")
    try:
        from utils.sync_controller import SyncController
        sync_controller_instance = SyncController()  # Get an instance of SyncController
        
        if operation == "INSERT":
            return sync_controller_instance.queue_for_sync(table_name, record, change_type="INSERT")
        elif operation == "UPDATE":
            return sync_controller_instance.queue_for_sync(table_name, record, change_type="UPDATE")
        elif operation == "DELETE":
            supabase: Client = get_supabase_client()
            if not supabase:
                logger.error("Supabase client not available for immediate DELETE sync.")
                return False
            
            response = supabase.from_(table_name.lower()).delete().eq("id", record.get("id")).execute()
            
            if response.data:
                logger.info(f"Successfully synced DELETE for {table_name}: {record.get('id')}")
                # Log to sync_table if needed for DELETE
                try:
                    sync_controller_instance._log_to_sync_table(
                        supabase=supabase,
                        table_name=table_name,
                        record_id=record.get('id'),
                        operation_type='DELETE',
                        change_data=record,
                        source='local',
                        status='synced'
                    )
                except Exception as log_err:
                    logger.error(f"Error logging DELETE to sync_table: {log_err}")
                return True
            else:
                logger.error(f"Failed to sync DELETE for {table_name}: {record.get('id')} - Response: {response.data}")
                return False
        else:
            logger.error(f"Unsupported operation type: {operation}")
            return False
    except Exception as e:
        logger.error(f"Error during immediate sync for {table_name}: {e}")
        return False


def get_supabase_data(table_name: str, filters: Optional[Dict[str, Any]] = None) -> Optional[List[Dict]]:
    """Supabase-first read with local JSON fallback cache."""
    try:
        supabase: Client = get_supabase_client()
        if not supabase:
            logger.warning("Supabase client not available; using local cache fallback.")
            return _read_local_cache(table_name)
        
        query = supabase.from_(table_name.lower()).select("*")
        
        # ✅ ADDED: Automatic filtering for Users table to exclude super_admin
        if table_name.lower() == 'users':
            query = query.neq('role', 'super_admin')
            logger.debug("Automatically excluding super_admin users from query")
        
        if filters:
            for column, value in filters.items():
                query = query.eq(column, value)
        
        response = query.execute()
        
        records = response.data or []
        # Refresh local cache from cloud truth for unfiltered reads.
        if not filters:
            try:
                _refresh_local_cache(table_name, records)
            except Exception as cache_error:
                logger.warning(f"Failed to refresh local cache for {table_name}: {cache_error}")
        return records
            
    except Exception as e:
        logger.warning(f"Error fetching from Supabase {table_name}, using local cache fallback: {e}")
        return _read_local_cache(table_name)


def check_user_exists_supabase(user_id: str) -> bool:
    """Check if a user exists in Supabase Users table"""
    if not user_id:
        return False
    result = get_supabase_data('users', {'id': user_id})
    return result is not None and len(result) > 0


def check_customer_exists_supabase(customer_id: str) -> bool:
    """Check if a customer exists in Supabase Customers table"""
    if not customer_id:
        return False
    result = get_supabase_data('customers', {'id': customer_id})
    return result is not None and len(result) > 0


def check_product_exists_supabase(product_id: str) -> bool:
    """Check if a product exists in Supabase Products table"""
    if not product_id:
        return False
    result = get_supabase_data('products', {'id': product_id})
    return result is not None and len(result) > 0


def get_product_barcodes_supabase(product_id: str) -> List[str]:
    """Get the barcode for a product from the Products table"""
    if not product_id:
        return []
    
    try:
        supabase: Client = get_supabase_client()
        if not supabase:
            logger.error("Supabase client not available for fetching product barcode.")
            return []
        
        response = supabase.from_('products').select("barcode").eq("id", product_id).execute()
        
        if response.data and response.data[0].get('barcode'):
            return [response.data[0]['barcode']]
        return []
        
    except Exception as e:
        logger.error(f"Error fetching barcode for product {product_id} from Supabase: {e}")
        return []
