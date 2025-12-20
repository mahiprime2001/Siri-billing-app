import logging
import json
from datetime import datetime, timedelta, date
from decimal import Decimal
from typing import List, Dict, Any, Optional
from supabase import Client
from postgrest.exceptions import APIError
from utils.connection_pool import get_supabase_client
from helpers.utils import read_json_file, write_json_file
from config.config import (
    USERS_FILE, PRODUCTS_FILE, BILLS_FILE, CUSTOMERS_FILE,
    SYSTEM_SETTINGS_FILE, STORES_FILE, RETURNS_FILE, BILL_FORMATS_FILE, USER_STORES_FILE
)

logger = logging.getLogger("sync_controller")

def json_serial(obj):
    """JSON serializer for objects not serializable by default"""
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError(f"Type {type(obj)} not serializable")

class SyncController:
    _instance = None
    _is_initialized = False

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if not self._is_initialized:
            self.sync_queue = []
            self.last_sync_timestamp: Optional[str] = None
            self._is_initialized = True

    def get_sync_status(self) -> Dict[str, Any]:
        """Return the current sync status."""
        supabase: Client = get_supabase_client()
        database_connected = bool(supabase)  # Check if client is available

        # Attempt a simple query to verify connection if client exists
        if database_connected:
            try:
                # Attempt to get a small piece of non-sensitive data, e.g., app_config count
                response = supabase.from_("app_config").select("id").limit(1).execute()
                if response.data is None:  # If data is None, connection might be problematic
                    database_connected = False
            except Exception as e:
                logger.warning(f"Supabase connection test failed: {e}")
                database_connected = False

        return {
            "database_connected": database_connected,
            "last_sync": self.last_sync_timestamp,
            "queue_size": len(self.sync_queue)
        }

    def _log_to_sync_table(self, supabase: Client, table_name: str, record_id: str, operation_type: str, change_data: Dict, source: str = "local", status: str = "pending", error_message: Optional[str] = None):
        """
        Logs a sync operation to the `sync_table` in Supabase.
        """
        try:
            log_entry = {
                "table_name": table_name,
                "record_id": record_id,
                "operation_type": operation_type,  # INSERT, UPDATE, DELETE
                "change_data": json.dumps(change_data, default=json_serial),  # Store JSON string of the changed data
                "source": source,  # 'local' or 'supabase'
                "status": status,  # 'pending', 'synced', 'failed'
                "sync_attempts": 0,  # Initial attempts
                "created_at": datetime.now().isoformat(),
                "source_app": "billing-app",  # Identify the source application
                "retry_count": 0,
                "error_message": error_message
            }

            # Use `on_conflict` to handle cases where a record might be queued multiple times
            # For simplicity, we'll just insert here. A more robust solution might check for existing.
            response = supabase.from_("sync_table").insert(log_entry).execute()
            if response.data:
                logger.info(f"Logged sync operation for {table_name}:{record_id} ({operation_type}) to sync_table.")
            else:
                logger.error(f"Failed to log sync operation to sync_table: {response.data}")
        except Exception as e:
            logger.error(f"Error logging to sync_table for {table_name}:{record_id}: {e}")

    def queue_for_sync(self, table_name: str, record: Dict, change_type: str) -> bool:
        """
        Queues a record for synchronization to Supabase.
        change_type should be 'INSERT' or 'UPDATE'.
        """
        if not record or not record.get("id"):
            logger.error(f"Invalid record for queuing: {record}")
            return False

        item = {
            "table_name": table_name,
            "record": record,
            "change_type": change_type,
            "timestamp": datetime.now().isoformat(),
            "attempts": 0
        }

        self.sync_queue.append(item)
        logger.info(f"Queued {change_type} for {table_name}: {record.get('id')}. Queue size: {len(self.sync_queue)}")
        return True

    def process_sync_queue(self):
        """
        Processes the synchronization queue, pushing changes to Supabase.
        """
        logger.info(f"Processing sync queue. Current size: {len(self.sync_queue)}")
        supabase: Client = get_supabase_client()

        if not supabase:
            logger.error("Supabase client not available for processing sync queue.")
            return

        items_to_retry = []

        while self.sync_queue:
            item = self.sync_queue.pop(0)  # Get the oldest item
            table_name = item["table_name"]
            record = item["record"]
            change_type = item["change_type"]
            record_id = record.get("id")
            item["attempts"] += 1

            try:
                if change_type == "INSERT":
                    response = supabase.from_(table_name.lower()).insert(record).execute()
                elif change_type == "UPDATE":
                    response = supabase.from_(table_name.lower()).update(record).eq("id", record_id).execute()
                else:
                    logger.error(f"Unsupported change type in queue: {change_type}")
                    self._log_to_sync_table(supabase, table_name, record_id, change_type, record, status="failed", error_message=f"Unsupported change type: {change_type}")
                    continue

                if response.data:
                    logger.info(f"Successfully synced {change_type} for {table_name}: {record_id}")
                    self._log_to_sync_table(supabase, table_name, record_id, change_type, record, status="synced")
                else:
                    # This part might need more sophisticated error handling based on Supabase client exceptions
                    logger.error(f"Failed to sync {change_type} for {table_name}: {record_id} - Response: {response.data}")
                    error_message = f"Supabase response error: {response.data}"
                    if item["attempts"] < 3:  # Retry a few times
                        items_to_retry.append(item)
                        self._log_to_sync_table(supabase, table_name, record_id, change_type, record, status="pending", error_message=error_message)
                    else:
                        logger.error(f"Max retries reached for {table_name}:{record_id}. Giving up.")
                        self._log_to_sync_table(supabase, table_name, record_id, change_type, record, status="failed", error_message=error_message)

            except APIError as e:
                logger.error(f"Supabase API error during {change_type} for {table_name}:{record_id}: {str(e)}")
                error_message = str(e)
                if item["attempts"] < 3:  # Retry a few times
                    items_to_retry.append(item)
                    self._log_to_sync_table(supabase, table_name, record_id, change_type, record, status="pending", error_message=error_message)
                else:
                    logger.error(f"Max retries reached for {table_name}:{record_id}. Giving up.")
                    self._log_to_sync_table(supabase, table_name, record_id, change_type, record, status="failed", error_message=error_message)

            except Exception as e:
                logger.error(f"Error processing sync item for {table_name}:{record_id}: {e}")
                error_message = str(e)
                if item["attempts"] < 3:  # Retry a few times
                    items_to_retry.append(item)
                    self._log_to_sync_table(supabase, table_name, record_id, change_type, record, status="pending", error_message=error_message)
                else:
                    logger.error(f"Max retries reached for {table_name}:{record_id}. Giving up.")
                    self._log_to_sync_table(supabase, table_name, record_id, change_type, record, status="failed", error_message=error_message)

        # Add items that need to be retried back to the queue
        self.sync_queue.extend(items_to_retry)
        if items_to_retry:
            logger.warning(f"Added {len(items_to_retry)} items back to queue for retry.")

    def push_sync(self, sync_data: Dict[str, List[Dict]]) -> Dict[str, Any]:
        """
        Synchronizes data from local JSON files (or any provided data) to Supabase.
        This is a more aggressive push, overwriting Supabase data based on local.
        """
        logger.info("Starting push_sync (local JSON to Supabase)")
        supabase: Client = get_supabase_client()
        results = {
            "success": False,
            "stats": {},
            "errors": []
        }

        if not supabase:
            logger.error("No Supabase client available for push_sync")
            results["errors"].append("Failed to get Supabase client")
            return results

        for table_name, records in sync_data.items():
            logger.info(f"Push syncing table {table_name} with {len(records)} records")
            try:
                # For simplicity in initial implementation, we'll try to insert/upsert all records.
                # A more complex logic might involve checking last_updated timestamps.
                # Using upsert (on_conflict) to handle existing records.
                response = supabase.from_(table_name.lower()).upsert(records, on_conflict="id").execute()

                if response.data:
                    results["stats"][table_name] = {"pushed": len(response.data)}
                    logger.info(f"Successfully push synced {len(response.data)} records to {table_name}")
                else:
                    logger.error(f"Failed to push sync {table_name}: {response.data}")
                    results["errors"].append(f"{table_name}: Failed to push - {response.data}")

            except APIError as e:
                logger.error(f"Supabase API error during push sync for {table_name}: {str(e)}")
                results["errors"].append(f"{table_name}: Supabase API Error - {str(e)}")

            except Exception as e:
                logger.error(f"Error during push sync for {table_name}: {e}")
                results["errors"].append(f"{table_name}: General Error - {e}")

        if not results["errors"]:
            results["success"] = True

        logger.info("Finished push_sync")
        return results

    def pull_sync(self, last_sync: Optional[str], tables: Optional[List[str]] = None) -> Dict[str, Any]:
        """
        Pull updates from Supabase since last sync (delta sync)
        """
        logger.info("Starting pull_sync")
        supabase: Optional[Client] = None
        results = {
            'success': False,
            'data': {},
            'errors': [],
            'sync_timestamp': datetime.now().isoformat()
        }

        # Default tables to sync - UPDATED TO INCLUDE UserStores
        if tables is None:
            tables = ['Products', 'Customers', 'Users', 'Stores', 'SystemSettings',
                      'BillFormats', 'Returns', 'Notifications', 'Bills', 'UserStores']

        try:
            supabase = get_supabase_client()
            if not supabase:
                logger.error("No Supabase client available at pull_sync start")
                results['errors'].append('Failed to get Supabase client')
                return results

            for table_name in tables:
                logger.debug(f"Pull syncing table {table_name}")
                try:
                    query = supabase.from_(table_name.lower()).select("*")

                    if last_sync:
                        # Use specific timestamp column names for filtering
                        filter_conditions = []
                        # Tables with camelCase 'updatedat' and 'createdat'
                        if table_name in ['Products', 'Customers', 'Users', 'Stores', 'Batch', 'Batch_new', 'StoreInventory']:
                            filter_conditions.append(f"updatedat.gte.{last_sync}")
                            filter_conditions.append(f"createdat.gte.{last_sync}")
                        # Tables with snake_case 'updated_at' and 'created_at'
                        elif table_name in ['App_Config', 'BillItems', 'Bills', 'Notifications', 'Password_Change_Log',
                                           'Password_Reset_Tokens', 'Returns', 'Sync_Table', 'SystemSettings', 'UserStores']:
                            filter_conditions.append(f"updated_at.gte.{last_sync}")
                            filter_conditions.append(f"created_at.gte.{last_sync}")

                        if filter_conditions:
                            query = query.or_(",".join(filter_conditions))

                    order_column = None
                    # Tables with camelCase 'updatedat'
                    if table_name in ['Products', 'Customers', 'Users', 'Stores', 'Batch', 'Batch_new', 'StoreInventory']:
                        order_column = "updatedat"
                    # Tables with snake_case 'updated_at'
                    elif table_name in ['App_Config', 'BillItems', 'Bills', 'Notifications', 'Password_Change_Log',
                                       'Password_Reset_Tokens', 'Returns', 'Sync_Table', 'SystemSettings', 'UserStores']:
                        order_column = "updated_at"

                    # BillFormats does not have a timestamp column for ordering
                    if order_column:
                        response = query.order(order_column, desc=True).execute()
                    else:
                        response = query.execute()

                    if response.data:
                        # Remove 'assignedStoreId' if present in Products table
                        if table_name == 'Products':
                            for record in response.data:
                                if 'assignedStoreId' in record:
                                    del record['assignedStoreId']
                                if 'batchId' in record:  # Also remove batchId if it's causing issues
                                    del record['batchId']

                        results['data'][table_name] = response.data
                        logger.info(f"Completed pull sync on table {table_name} with {len(response.data)} records")
                    elif not response.data:  # Check for empty data instead of status_code
                        results['data'][table_name] = []
                        logger.info(f"No new records for table {table_name} since last sync.")
                    else:
                        # This case should ideally not be reached if response.data is checked first
                        logger.error(f"Error fetching from Supabase {table_name}: Unknown response {response}")
                        results['errors'].append(f"{table_name}: Supabase Error - Unknown response {response}")

                except Exception as e:
                    logger.error(f"General error on pull sync table {table_name}: {e}")
                    results['errors'].append(f"{table_name}: General Error - {e}")

            results['success'] = True
            logger.info("Finished pull_sync")

        except Exception as e:
            logger.error(f"General error during pull_sync: {e}")
            results['errors'].append(f"Sync error: {e}")

        return results
