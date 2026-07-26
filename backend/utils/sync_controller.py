import logging
import json
from datetime import datetime, date
from decimal import Decimal
from typing import List, Dict, Any, Optional
from supabase import Client
from utils.connection_pool import get_supabase_client, get_client_status

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
            self.last_sync_timestamp: Optional[str] = None
            self._is_initialized = True

    def get_sync_status(self) -> Dict[str, Any]:
        """Return the current sync status."""
        supabase: Client = get_supabase_client()
        is_fallback_client = (not supabase) or getattr(supabase, "is_offline_fallback", False)
        database_connected = not is_fallback_client

        # Attempt a simple query to verify cloud connection if this is not fallback client
        if database_connected:
            try:
                # Attempt to get a small piece of non-sensitive data from an always-present table.
                response = supabase.from_("systemsettings").select("id").limit(1).execute()
                if response.data is None:  # If data is None, connection might be problematic
                    database_connected = False
            except Exception as e:
                logger.warning(f"Supabase connection test failed: {e}")
                database_connected = False

        try:
            from utils.offline_bill_queue import get_queue_status as _bill_queue_status
            from utils.offline_damage_return_queue import get_queue_status as _damage_queue_status
            from utils.offline_transfer_verification_queue import get_queue_status as _transfer_queue_status

            bill_q = _bill_queue_status()
            damage_q = _damage_queue_status()
            transfer_q = _transfer_queue_status()
        except Exception as e:
            logger.warning(f"Could not read offline queue status: {e}")
            bill_q = {"size": 0}
            damage_q = {"size": 0}
            transfer_q = {"size": 0}

        offline_total = int(bill_q.get("size", 0)) + int(damage_q.get("size", 0)) + int(transfer_q.get("size", 0))

        return {
            "database_connected": database_connected,
            "mode": "cloud" if database_connected else "fallback",
            "last_sync": self.last_sync_timestamp,
            "queue_size": offline_total,
            "cloud_connection": get_client_status(),
            "offline_queues": {
                "bills": bill_q,
                "damage_returns": damage_q,
                "transfer_verifications": transfer_q,
                "total_size": offline_total,
            },
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
                      'BillFormats', 'Returns', 'Notifications', 'Bills', 'UserStores',
                      'Inventory_Transfer_Orders', 'Inventory_Transfer_Items',
                      'Inventory_Transfer_Scans', 'Inventory_Transfer_Verifications',
                      'Damaged_Inventory_Events', 'Store_Damage_Returns']

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
                                           'Password_Reset_Tokens', 'Returns', 'Sync_Table', 'SystemSettings', 'UserStores',
                                           'Inventory_Transfer_Orders', 'Inventory_Transfer_Items',
                                           'Inventory_Transfer_Scans', 'Damaged_Inventory_Events',
                                           'Store_Damage_Returns']:
                            filter_conditions.append(f"updated_at.gte.{last_sync}")
                            filter_conditions.append(f"created_at.gte.{last_sync}")
                        elif table_name in ['Inventory_Transfer_Verifications']:
                            filter_conditions.append(f"submitted_at.gte.{last_sync}")

                        if filter_conditions:
                            query = query.or_(",".join(filter_conditions))

                    order_column = None
                    # Tables with camelCase 'updatedat'
                    if table_name in ['Products', 'Customers', 'Users', 'Stores', 'Batch', 'Batch_new', 'StoreInventory']:
                        order_column = "updatedat"
                    # Tables with snake_case 'updated_at'
                    elif table_name in ['App_Config', 'BillItems', 'Bills', 'Notifications', 'Password_Change_Log',
                                       'Password_Reset_Tokens', 'Returns', 'Sync_Table', 'SystemSettings', 'UserStores',
                                       'Inventory_Transfer_Orders', 'Inventory_Transfer_Items',
                                       'Inventory_Transfer_Scans', 'Damaged_Inventory_Events',
                                       'Store_Damage_Returns']:
                        order_column = "updated_at"
                    elif table_name in ['Inventory_Transfer_Verifications']:
                        order_column = "submitted_at"

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
                    if "timed out" in str(e).lower() or "timeout" in str(e).lower():
                        # Stop this cycle on connectivity failures to avoid log spam on every table.
                        logger.warning("Timeout detected during pull_sync; aborting remaining tables for this cycle.")
                        results['success'] = False
                        return results

            results['success'] = True
            logger.info("Finished pull_sync")

        except Exception as e:
            logger.error(f"General error during pull_sync: {e}")
            results['errors'].append(f"Sync error: {e}")

        return results
