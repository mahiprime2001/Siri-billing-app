"""
Sync Controller - Manages push/pull sync operations between apps and Supabase
Implements delta sync, conflict resolution, batch operations, and sync_table logging
"""

import json
import traceback
from datetime import datetime, date
from typing import Dict, List, Any, Optional
import logging
from decimal import Decimal
import re # Import re module for regex operations

from .connection_pool import get_supabase_client
from supabase import Client # Import Client for type hinting
from postgrest.exceptions import APIError # Import APIError for specific exception handling

# Configure logging
logger = logging.getLogger('sync_controller')


def normalize_timestamp(timestamp_str: str) -> str:
    """Normalizes an ISO 8601 timestamp string to have 6 digits for microseconds."""
    if not timestamp_str:
        return timestamp_str
    
    # Handle optional 'Z' or timezone offset if not already handled
    normalized = timestamp_str.replace('Z', '+00:00')

    # Regex to find the fractional seconds part
    match = re.search(r'\.(\d+)', normalized)
    if match:
        fractional_seconds = match.group(1)
        if len(fractional_seconds) > 6:
            # Truncate to 6 microseconds
            normalized = re.sub(r'\.(\d+)', f".{fractional_seconds[:6]}", normalized)
        elif len(fractional_seconds) < 6:
            # Pad with zeros to 6 microseconds
            # Ensure we only add padding if there's no timezone offset after the fractional seconds
            if '+' in normalized or '-' in normalized and len(normalized.split('-')[-1]) == 4: # Check for +HH:MM or -HHMM
                 # If there is a timezone offset, apply padding before it
                parts = re.split(r'([+-]\d{2}(?::?\d{2})?)$', normalized)
                normalized = f"{parts[0]}{'0' * (6 - len(fractional_seconds))}{parts[1]}" if len(parts) > 1 else normalized
            else:
                normalized = f"{normalized}{'0' * (6 - len(fractional_seconds))}"
    elif 'T' in normalized and '.' not in normalized:
        # If there's a 'T' but no fractional seconds, add '.000000'
        # Check if there is a timezone offset directly after 'T'
        if re.search(r'T[+-]\d{2}(?::?\d{2})?$', normalized):
            parts = re.split(r'([+-]\d{2}(?::?\d{2})?)$', normalized)
            normalized = f"{parts[0]}.000000{parts[1]}" if len(parts) > 1 else normalized
        else:
            normalized = f"{normalized}.000000"
        
    return normalized


def json_serial(obj):
    """JSON serializer for objects not serializable by default"""
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError(f"Type {type(obj)} not serializable")


class ConflictResolver:
    """Handles conflict resolution between local JSON and Supabase records"""
    
    @staticmethod
    def resolve_by_timestamp(table_name: str, local_record: Dict, supabase_record: Dict) -> Dict:
        """
        Resolve conflict using 'last updated wins' strategy
        Returns the record with the most recent updatedAt timestamp
        """
        logger.debug(f"Resolving conflict by timestamp for table {table_name}, record ID {local_record.get('id')}")
        
        # Use specific timestamp column names based on table (from supabase_schema.txt)
        # Tables with camelCase 'updatedat'
        if table_name in ['Products', 'Customers', 'Users', 'Stores', 'Batch', 'Batch_new', 'StoreInventory']:
            local_updated = local_record.get('updatedat', '')
            supabase_updated = supabase_record.get('updatedat', '')
        # Tables with snake_case 'updated_at'
        elif table_name in ['App_Config', 'BillItems', 'Bills', 'Notifications', 'Password_Change_Log', 'Password_Reset_Tokens', 'Returns', 'Sync_Table', 'SystemSettings', 'UserStores']:
            local_updated = local_record.get('updated_at', '')
            supabase_updated = supabase_record.get('updated_at', '')
        else: # Default for tables without explicit timestamp columns or unknown, or BillFormats
            local_updated = local_record.get('updated_at', local_record.get('updatedat', ''))
            supabase_updated = supabase_record.get('updated_at', supabase_record.get('updatedat', ''))

        if not local_updated:
            logger.debug(f"Local updated timestamp missing for {table_name}, using Supabase record")
            return supabase_record
        
        if not supabase_updated:
            logger.debug("Supabase updatedAt missing, using local record")
            return local_record
        
        try:
            # Normalize timestamps before comparison
            normalized_local_updated = normalize_timestamp(local_updated)
            normalized_supabase_updated = normalize_timestamp(supabase_updated)

            local_dt = datetime.fromisoformat(normalized_local_updated)
            supabase_dt = datetime.fromisoformat(normalized_supabase_updated)
            
            logger.debug(f"Local timestamp: {local_dt}, Supabase timestamp: {supabase_dt}")
            
            if local_dt > supabase_dt:
                logger.info(f"Conflict resolved: Local record is newer (ID: {local_record.get('id')})")
                return local_record
            else:
                logger.info(f"Conflict resolved: Supabase record is newer (ID: {supabase_record.get('id')})")
                return supabase_record
        
        except Exception as e:
            logger.error(f"Error comparing timestamps: Invalid isoformat string or other issue: {e}. Local: '{local_updated}', Supabase: '{supabase_updated}'")
            return local_record  # Default to local on error
    
    @staticmethod
    def resolve_by_rule(table_name: str, local_record: Dict, supabase_record: Dict) -> Dict:
        """
        Apply table-specific conflict resolution rules
        """
        logger.debug(f"Resolving conflict for table {table_name}, record ID {local_record.get('id')}")
        
        # Bills and BillItems: Local always wins (billing app creates these)
        if table_name in ['Bills', 'BillItems']:
            logger.info(f"Conflict resolved: Local wins for {table_name} (ID: {local_record.get('id')})")
            return local_record
        
        # For other tables: Use timestamp-based resolution
        return ConflictResolver.resolve_by_timestamp(table_name, local_record, supabase_record)


class SyncController:
    """Main sync controller for managing data synchronization"""
    
    def __init__(self):
        logger.info("Initializing SyncController")
        self.conflict_resolver = ConflictResolver()
    
    def _check_user_exists_in_supabase(self, supabase: Client, user_id: str) -> bool:
        """Check if a user exists in Supabase Users table"""
        if not user_id:
            return False
        
        try:
            logger.debug(f"Checking if user {user_id} exists in Supabase")
            response = supabase.from_("users").select("id").eq("id", user_id).execute()
            exists = len(response.data) > 0
            logger.debug(f"User {user_id} exists in Supabase: {exists}")
            return exists
        
        except Exception as e:
            logger.error(f"Error checking user existence for {user_id}: {e}")
            return False
    
    def _validate_bill_for_sync(self, supabase: Client, bill_record: Dict) -> Dict[str, Any]:
        """
        Validate if a bill should be synced to Supabase
        Returns validation result with status and reason
        """
        result = {
            'should_sync': True,
            'reason': '',
            'is_test_bill': False
        }
        
        # Check if bill has createdBy field
        created_by = bill_record.get('createdBy')
        if not created_by:
            result.update({
                'should_sync': False,
                'reason': 'Bill missing createdBy field',
                'is_test_bill': True
            })
            logger.warning(f"Bill {bill_record.get('id')} has no createdBy field - marking as test bill")
            return result
        
        # Check if user exists in Supabase
        if not self._check_user_exists_in_supabase(supabase, created_by):
            result.update({
                'should_sync': False,
                'reason': f'User {created_by} does not exist in Supabase',
                'is_test_bill': True
            })
            logger.warning(f"Bill {bill_record.get('id')} created by non-existent user {created_by} - marking as test bill")
            return result
        
        logger.debug(f"Bill {bill_record.get('id')} validation passed - will sync to Supabase")
        return result
    
    def _log_to_sync_table(self, supabase: Client, table_name: str, record_id: str, 
                           operation_type: str, change_data: Dict, 
                           source: str = 'local', status: str = 'synced'):
        """
        Log changes to sync_table for audit trail and tracking in Supabase
        """
        try:
            # Serialize change_data to JSON
            change_data_json = json.dumps(change_data, default=json_serial)
            
            # Get current timestamp
            now = datetime.now().isoformat()
            synced_at = now if status == 'synced' else None
            
            # Insert into sync_table
            # The 'id' column is auto-incrementing in Supabase, so it should not be provided in the insert data.
            insert_data = {
                "table_name": table_name,
                "record_id": str(record_id),
                "operation_type": operation_type,
                "change_data": change_data_json,
                "source": source,
                "status": status,
                "sync_attempts": 1 if status == 'synced' else 0,
                "created_at": now,
                "synced_at": synced_at
            }
            
            response = supabase.from_("sync_table").insert(insert_data).execute()
            
            if response.data:
                logger.debug(f"Logged {operation_type} for {table_name}:{record_id} to sync_table with status {status}")
            else:
                logger.error(f"Failed to log to sync_table for {table_name}:{record_id}. Response: {response.data}")
                raise Exception(f"Failed to log to sync_table: {response.data}")
            
        except APIError as e:
            if hasattr(e, 'code') and e.code == '23505':
                logger.warning(f"Duplicate key error logging to sync_table for {table_name}:{record_id}. Sync record logging skipped. Error: {e}")
            else:
                logger.error(f"Error logging to sync_table: {e}\n{traceback.format_exc()}")
                raise  # Re-raise to trigger higher-level error handling
        except Exception as e:
            logger.error(f"Error logging to sync_table: {e}\n{traceback.format_exc()}")
            raise  # Re-raise to trigger higher-level error handling
    
    def push_sync(self, sync_data: Dict[str, List[Dict]]) -> Dict[str, Any]:
        """
        Push unsynced data from app to Supabase with user validation for bills
        """
        logger.info("Starting push_sync")
        supabase: Optional[Client] = None
        
        results = {
            'success': False,
            'synced_ids': {},
            'errors': [],
            'test_bills': [],  # Track bills that were marked as test bills
            'stats': {
                'total_records': 0,
                'synced': 0,
                'failed': 0,
                'test_bills': 0
            }
        }
        
        try:
            supabase = get_supabase_client()
            if not supabase:
                logger.error("No Supabase client available at push_sync start")
                results['errors'].append('Failed to get Supabase client')
                return results
            
            for table_name, records in sync_data.items():
                logger.debug(f"Processing table: {table_name} with {len(records)} records")
                
                if not records:
                    continue
                
                results['stats']['total_records'] += len(records)
                synced_ids = []
                
                for record in records:
                    record_id = record.get('id')
                    logger.debug(f"Processing record ID {record_id} in {table_name}")
                    
                    if not record_id:
                        logger.warning(f"Record missing ID in table {table_name}, skipping")
                        results['stats']['failed'] += 1
                        continue
                    
                    try:
                        # Special validation for Bills table
                        if table_name == 'Bills':
                            validation = self._validate_bill_for_sync(supabase, record)
                            if not validation['should_sync']:
                                logger.info(f"Bill {record_id} marked as test bill: {validation['reason']}")
                                results['test_bills'].append({
                                    'id': record_id,
                                    'reason': validation['reason']
                                })
                                results['stats']['test_bills'] += 1
                                # Still mark as "synced" locally but don't actually sync to Supabase
                                synced_ids.append(record_id)
                                continue
                        
                        # Fetch existing record from Supabase
                        existing_response = supabase.from_(table_name.lower()).select("*").eq("id", record_id).execute()
                        existing_record = existing_response.data[0] if existing_response.data else None
                        
                        if existing_record:
                            logger.debug("Record exists in DB, resolving conflicts")
                            winning_record = self.conflict_resolver.resolve_by_rule(table_name, record, existing_record)
                            
                            if winning_record == record:
                                logger.debug(f"Updating record ID {record_id} in {table_name}")
                                self._update_record(supabase, table_name, record)
                                self._log_to_sync_table(supabase, table_name, record_id, 'UPDATE', record)
                                synced_ids.append(record_id)
                                results['stats']['synced'] += 1
                            else:
                                logger.info(f"DB record is newer for {table_name} ID {record_id}, skipping update")
                                synced_ids.append(record_id)
                        else:
                            logger.debug(f"Inserting new record ID {record_id} into {table_name}")
                            self._insert_record(supabase, table_name, record)
                            self._log_to_sync_table(supabase, table_name, record_id, 'CREATE', record)
                            synced_ids.append(record_id)
                            results['stats']['synced'] += 1
                    
                    except Exception as e:
                        logger.error(f"Error syncing record {record_id} in {table_name}: {e}\n{traceback.format_exc()}")
                        results['errors'].append(f"{table_name}.{record_id}: {e}")
                        results['stats']['failed'] += 1
                
                results['synced_ids'][table_name] = synced_ids
            
            logger.info(f"push_sync success with {results['stats']['synced']} records synced, {results['stats']['test_bills']} test bills skipped")
            results['success'] = True
        
        except Exception as e:
            logger.error(f"General error during push_sync: {e}\n{traceback.format_exc()}")
            results['errors'].append(f"Sync error: {e}")
        
        finally:
            logger.info("Finishing push_sync")
        
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
        
        # Default tables to sync
        if tables is None:
            tables = ['Products', 'Customers', 'Users', 'Stores', 'SystemSettings', 'BillFormats', 'Returns', 'Notifications', 'Bills']
        
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
                        elif table_name in ['App_Config', 'BillItems', 'Bills', 'Notifications', 'Password_Change_Log', 'Password_Reset_Tokens', 'Returns', 'Sync_Table', 'SystemSettings', 'UserStores']:
                            filter_conditions.append(f"updated_at.gte.{last_sync}")
                            filter_conditions.append(f"created_at.gte.{last_sync}")
                        
                        if filter_conditions:
                            query = query.or_(",".join(filter_conditions))
                    
                    order_column = None
                    # Tables with camelCase 'updatedat'
                    if table_name in ['Products', 'Customers', 'Users', 'Stores', 'Batch', 'Batch_new', 'StoreInventory']:
                        order_column = "updatedat"
                    # Tables with snake_case 'updated_at'
                    elif table_name in ['App_Config', 'BillItems', 'Bills', 'Notifications', 'Password_Change_Log', 'Password_Reset_Tokens', 'Returns', 'Sync_Table', 'SystemSettings', 'UserStores']:
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
                                if 'batchId' in record: # Also remove batchId if it's causing issues
                                    del record['batchId']

                        results['data'][table_name] = response.data
                        logger.info(f"Completed pull sync on table {table_name} with {len(response.data)} records")
                    elif not response.data: # Check for empty data instead of status_code
                        results['data'][table_name] = []
                        logger.info(f"No new records for table {table_name} since last sync.")
                    else:
                        # This case should ideally not be reached if response.data is checked first
                        logger.error(f"Error fetching from Supabase {table_name}: Unknown response {response}")
                        results['errors'].append(f"{table_name}: Supabase Error - Unknown response {response}")
                
                except Exception as e:
                    logger.error(f"General error on pull sync table {table_name}: {e}\n{traceback.format_exc()}")
                    results['errors'].append(f"{table_name}: General Error - {e}")
            
            results['success'] = True
            logger.info("Finished pull_sync")
        
        except Exception as e:
            logger.error(f"General error during pull_sync: {e}\n{traceback.format_exc()}")
            results['errors'].append(f"Sync error: {e}")
        
        return results
    
    def _transform_record_keys(self, table_name: str, record: Dict) -> Dict:
        """
        Transforms record keys from snake_case to camelCase for specific tables
        before sending to Supabase.
        """
        transformed_record = record.copy()
        
        camel_case_tables = ['Products', 'Customers', 'Users', 'Stores', 'Batch', 'Batch_new', 'StoreInventory']
        
        if table_name in camel_case_tables:
            # Normalize 'created_at' and 'createdAt' to 'createdat'
            if 'created_at' in transformed_record:
                transformed_record['createdat'] = transformed_record.pop('created_at')
            elif 'createdAt' in transformed_record: # Check for 'createdAt' (capital A)
                transformed_record['createdat'] = transformed_record.pop('createdAt')

            # Normalize 'updated_at' and 'updatedAt' to 'updatedat'
            if 'updated_at' in transformed_record:
                transformed_record['updatedat'] = transformed_record.pop('updated_at')
            elif 'updatedAt' in transformed_record: # Check for 'updatedAt' (capital A)
                transformed_record['updatedat'] = transformed_record.pop('updatedAt')
        
        return transformed_record

    def _insert_record(self, supabase: Client, table_name: str, record: Dict):
        """Insert a new record into Supabase"""
        logger.debug(f"Inserting record {record.get('id')} into {table_name}")
        payload = record.copy()  # Create a mutable copy for transformations
        
        # Pre-transformations specific to tables
        if table_name == 'Products':
            if 'assignedStoreId' in payload:
                del payload['assignedStoreId']
            if 'batchId' in payload:
                del payload['batchId']
            # FIX: Remove 'barcodes' (plural) field if it exists
            if 'barcodes' in payload:
                del payload['barcodes']
            # Ensure 'barcode' (singular) is a string
            if 'barcode' in payload and isinstance(payload['barcode'], list):
                payload['barcode'] = ','.join(payload['barcode'])
        
        if table_name == 'Bills':
            # FIX: Transform 'billFormat' to 'billformat' (lowercase)
            if 'billFormat' in payload:
                payload['billformat'] = payload.pop('billFormat')
        
        # Apply key transformation (for createdat/updatedat)
        transformed_record = self._transform_record_keys(table_name, payload)
        
        try:
            response = supabase.from_(table_name.lower()).insert(transformed_record).execute()
            if response.data:
                logger.debug(f"Inserted record {record.get('id')} into {table_name}")
            else:
                logger.error(f"Failed to insert record {record.get('id')} into {table_name}. Response: {response.data}")
                raise Exception(f"Supabase insert failed: {response.data}")
        except Exception as e:
            # Check if it's a duplicate key error
            if hasattr(e, 'code') and e.code == '23505':  # PostgreSQL duplicate key error code
                logger.warning(f"Duplicate key error on insert for {table_name} ID {record.get('id')}. Attempting update instead.")
                self._update_record(supabase, table_name, record)  # Attempt update
            else:
                logger.error(f"Error inserting record {record.get('id')} into {table_name}: {e}\n{traceback.format_exc()}")
                raise  # Re-raise if not a duplicate key error

    def _update_record(self, supabase: Client, table_name: str, record: Dict):
        """Update an existing record in Supabase"""
        logger.debug(f"Updating record {record.get('id')} in {table_name}")
        record_id = record.get('id')
        if not record_id:
            raise ValueError("Record ID is required for update operation.")
        
        payload = record.copy()  # Create a mutable copy for transformations
        
        # Pre-transformations specific to tables
        if table_name == 'Products':
            if 'assignedStoreId' in payload:
                del payload['assignedStoreId']
            if 'batchId' in payload:
                del payload['batchId']
            # FIX: Remove 'barcodes' (plural) field if it exists
            if 'barcodes' in payload:
                del payload['barcodes']
            # Ensure 'barcode' (singular) is a string
            if 'barcode' in payload and isinstance(payload['barcode'], list):
                payload['barcode'] = ','.join(payload['barcode'])
        
        if table_name == 'Bills':
            # FIX: Transform 'billFormat' to 'billformat' (lowercase)
            if 'billFormat' in payload:
                payload['billformat'] = payload.pop('billFormat')
        
        # Apply key transformation (for createdat/updatedat)
        transformed_record = self._transform_record_keys(table_name, payload)
        
        response = supabase.from_(table_name.lower()).update(transformed_record).eq("id", record_id).execute()
        if response.data:
            logger.debug(f"Updated record {record.get('id')} in {table_name}")
        else:
            logger.error(f"Failed to update record {record.get('id')} in {table_name}. Response: {response.data}")
            raise Exception(f"Supabase update failed: {response.data}")
    
    def queue_for_sync(self, table_name, record, change_type="INSERT"):
        """
        Immediately sync a record to Supabase (used by billing app)
        with foreign key validation and sync_table logging
        """
        supabase: Optional[Client] = None
        try:
            supabase = get_supabase_client()
            if not supabase:
                logger.error("No Supabase client available for immediate sync")
                return False
            
            try:
                # CRITICAL: Validate foreign key dependencies BEFORE insert
                if change_type == "INSERT":
                    if table_name == "Bills":
                        customer_id = record.get('customerId')
                        if customer_id:
                            response = supabase.from_("customers").select("id").eq("id", customer_id).execute()
                            if not response.data:
                                logger.error(f"Cannot insert Bill: Customer {customer_id} does not exist in Supabase")
                                return False
                    
                    elif table_name == "BillItems":
                        bill_id = record.get('billId')
                        if bill_id:
                            response = supabase.from_("bills").select("id").eq("id", bill_id).execute()
                            if not response.data:
                                logger.error(f"Cannot insert BillItem: Bill {bill_id} does not exist in Supabase")
                                return False
                
                record_id = record.get('id') or record.get('return_id')
                
                # Perform the actual data operation
                if change_type == "INSERT":
                    # The _insert_record method now handles transformations
                    self._insert_record(supabase, table_name, record)
                    logger.info(f"Queued and synced INSERT for {table_name}: {record_id}")
                elif change_type == "UPDATE":
                    # The _update_record method now handles transformations
                    self._update_record(supabase, table_name, record)
                    logger.info(f"Queued and synced UPDATE for {table_name}: {record_id}")
                
                # Log the change to sync_table for tracking
                self._log_to_sync_table(
                    supabase=supabase,
                    table_name=table_name,
                    record_id=record_id,
                    operation_type='CREATE' if change_type == 'INSERT' else 'UPDATE',
                    change_data=record,  # Store original record with all fields
                    source='local',
                    status='synced'
                )
                
                return True
            
            except Exception as e:
                logger.error(f"Error in queue_for_sync: {e}\n{traceback.format_exc()}")
                
                # Try to log failed sync attempt to sync_table
                try:
                    self._log_to_sync_table(
                        supabase=supabase,
                        table_name=table_name,
                        record_id=record.get('id', 'unknown'),
                        operation_type='CREATE' if change_type == 'INSERT' else 'UPDATE',
                        change_data=record,
                        source='local',
                        status='failed'
                    )
                except Exception as log_error:
                    logger.error(f"Failed to log error to sync_table during rollback: {log_error}")
                
                return False
            
        except Exception as e:
            logger.error(f"Error getting Supabase client for queue_for_sync: {e}")
            return False
    
    def get_sync_status(self) -> Dict[str, Any]:
        """Get current sync system status"""
        logger.debug("Getting sync status")
        supabase: Optional[Client] = None
        
        try:
            supabase = get_supabase_client()
            if not supabase:
                return {
                    'status': 'offline',
                    'message': 'Supabase client unavailable'
                }
            
            # Try to get last sync time from sync_table
            try:
                logger.debug("Querying sync_table for last sync status")
                response = supabase.from_("sync_table").select("created_at, operation_type, status") \
                                     .order("created_at", desc=True).limit(1).execute()
                
                last_sync = response.data[0] if response.data else None
                logger.debug(f"Last sync log fetched: {last_sync}")
            except Exception as e:
                logger.debug(f"Error fetching last sync log from Supabase: {e}")
                last_sync = None
            
            return {
                'status': 'online',
                'database_connected': True, # This now refers to Supabase
                'last_sync': last_sync.get('created_at') if last_sync and last_sync.get('created_at') else None,
                'last_sync_type': last_sync.get('operation_type') if last_sync else None,
                'last_sync_status': last_sync.get('status') if last_sync else None
            }
        
        except Exception as e:
            logger.error(f"Error getting sync status: {e}\n{traceback.format_exc()}")
            return {
                'status': 'error',
                'message': str(e)
            }
