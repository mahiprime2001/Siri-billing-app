import logging
from supabase import Client
from typing import List, Dict, Any, Optional
from utils.connection_pool import get_supabase_client
from utils.sync_controller import SyncController  # Keep this for now, will be refactored later

logger = logging.getLogger('supabase_data_access')

# Placeholder SyncController for now, will be properly integrated/refactored

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
    """Fetch data directly from Supabase with optional filters"""
    try:
        supabase: Client = get_supabase_client()
        if not supabase:
            logger.error("Supabase client not available for fetching data.")
            return None
        
        query = supabase.from_(table_name.lower()).select("*")
        
        # ✅ ADDED: Automatic filtering for Users table to exclude super_admin
        if table_name.lower() == 'users':
            query = query.neq('role', 'super_admin')
            logger.debug("Automatically excluding super_admin users from query")
        
        if filters:
            for column, value in filters.items():
                query = query.eq(column, value)
        
        response = query.execute()
        
        if response.data:
            return response.data
        else:
            # If response.data is empty, it means no records found, which is a successful query.
            # No need to check for status_code == 200 explicitly with new client behavior.
            return []
            
    except Exception as e:
        logger.error(f"Error fetching from Supabase {table_name}: {e}")
        return None


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
