"""
Sync Controller - Manages push/pull sync operations between apps and MySQL
Implements delta sync, conflict resolution, batch operations, and sync_table logging
"""

import os
import sys
import json
import traceback
from datetime import datetime, date
from typing import Dict, List, Any, Optional
import logging
from decimal import Decimal

from .connection_pool import get_connection
from mysql.connector import Error

# Configure logging
logger = logging.getLogger('sync_controller')


def json_serial(obj):
    """JSON serializer for objects not serializable by default"""
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError(f"Type {type(obj)} not serializable")


class ConflictResolver:
    """Handles conflict resolution between local JSON and MySQL records"""
    
    @staticmethod
    def resolve_by_timestamp(local_record: Dict, mysql_record: Dict) -> Dict:
        """
        Resolve conflict using 'last updated wins' strategy
        Returns the record with the most recent updatedAt timestamp
        """
        logger.debug(f"Resolving conflict by timestamp for record ID {local_record.get('id')}")
        
        local_updated = local_record.get('updatedAt', '')
        mysql_updated = mysql_record.get('updatedAt', '')
        
        if not local_updated:
            logger.debug("Local updatedAt missing, using MySQL record")
            return mysql_record
        
        if not mysql_updated:
            logger.debug("MySQL updatedAt missing, using local record")
            return local_record
        
        try:
            local_dt = datetime.fromisoformat(local_updated.replace('Z', '+00:00'))
            mysql_dt = datetime.fromisoformat(mysql_updated.replace('Z', '+00:00'))
            
            logger.debug(f"Local timestamp: {local_dt}, MySQL timestamp: {mysql_dt}")
            
            if local_dt > mysql_dt:
                logger.info(f"Conflict resolved: Local record is newer (ID: {local_record.get('id')})")
                return local_record
            else:
                logger.info(f"Conflict resolved: MySQL record is newer (ID: {mysql_record.get('id')})")
                return mysql_record
        
        except Exception as e:
            logger.error(f"Error comparing timestamps: {e}")
            return local_record  # Default to local on error
    
    @staticmethod
    def resolve_by_rule(table_name: str, local_record: Dict, mysql_record: Dict) -> Dict:
        """
        Apply table-specific conflict resolution rules
        """
        logger.debug(f"Resolving conflict for table {table_name}, record ID {local_record.get('id')}")
        
        # Bills and BillItems: Local always wins (billing app creates these)
        if table_name in ['Bills', 'BillItems']:
            logger.info(f"Conflict resolved: Local wins for {table_name} (ID: {local_record.get('id')})")
            return local_record
        
        # For other tables: Use timestamp-based resolution
        return ConflictResolver.resolve_by_timestamp(local_record, mysql_record)


class SyncController:
    """Main sync controller for managing data synchronization"""
    
    def __init__(self):
        logger.info("Initializing SyncController")
        self.conflict_resolver = ConflictResolver()
    
    def _get_table_columns(self, cursor, table_name):
        """Get column names from a table"""
        logger.debug(f"Getting columns for table {table_name}")
        
        try:
            cursor.execute(f"SHOW COLUMNS FROM {table_name}")
            columns_data = cursor.fetchall()
            
            # Handle both dictionary and tuple cursor results
            if columns_data and len(columns_data) > 0:
                if isinstance(columns_data[0], dict):
                    # Dictionary cursor - use 'Field' key
                    columns = [col['Field'] for col in columns_data]
                elif isinstance(columns_data[0], (tuple, list)):
                    # Tuple cursor - use first element
                    columns = [col[0] for col in columns_data]
                else:
                    logger.error(f"Unexpected column data format: {type(columns_data[0])}")
                    columns = []
            else:
                columns = []
            
            logger.debug(f"Columns for {table_name}: {columns}")
            return columns
        
        except Exception as e:
            logger.error(f"Error getting columns for {table_name}: {e}")
            return []
    
    def _check_user_exists_in_mysql(self, cursor, user_id: str) -> bool:
        """Check if a user exists in MySQL Users table"""
        if not user_id:
            return False
        
        try:
            logger.debug(f"Checking if user {user_id} exists in MySQL")
            cursor.execute("SELECT id FROM Users WHERE id = %s", (user_id,))
            result = cursor.fetchone()
            exists = result is not None
            logger.debug(f"User {user_id} exists in MySQL: {exists}")
            return exists
        
        except Exception as e:
            logger.error(f"Error checking user existence for {user_id}: {e}")
            return False
    
    def _validate_bill_for_sync(self, cursor, bill_record: Dict) -> Dict[str, Any]:
        """
        Validate if a bill should be synced to MySQL
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
        
        # Check if user exists in MySQL
        if not self._check_user_exists_in_mysql(cursor, created_by):
            result.update({
                'should_sync': False,
                'reason': f'User {created_by} does not exist in MySQL',
                'is_test_bill': True
            })
            logger.warning(f"Bill {bill_record.get('id')} created by non-existent user {created_by} - marking as test bill")
            return result
        
        logger.debug(f"Bill {bill_record.get('id')} validation passed - will sync to MySQL")
        return result
    
    def _log_to_sync_table(self, cursor, table_name: str, record_id: str, 
                           operation_type: str, change_data: Dict, 
                           source: str = 'local', status: str = 'synced'):
        """
        Log changes to sync_table for audit trail and tracking
        """
        try:
            # Serialize change_data to JSON
            change_data_json = json.dumps(change_data, default=json_serial)
            
            # Get current timestamp
            now = datetime.now()
            synced_at = now if status == 'synced' else None
            
            # Insert into sync_table
            insert_query = """
                INSERT INTO sync_table 
                (table_name, record_id, operation_type, change_data, source, status, sync_attempts, created_at, synced_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """
            
            cursor.execute(insert_query, (
                table_name,
                str(record_id),
                operation_type,
                change_data_json,
                source,
                status,
                1 if status == 'synced' else 0,
                now,
                synced_at
            ))
            
            logger.debug(f"Logged {operation_type} for {table_name}:{record_id} to sync_table with status {status}")
            
        except Exception as e:
            logger.error(f"Error logging to sync_table: {e}\n{traceback.format_exc()}")
            raise  # Re-raise to trigger rollback
    
    def push_sync(self, sync_data: Dict[str, List[Dict]]) -> Dict[str, Any]:
        """
        Push unsynced data from app to MySQL with user validation for bills
        """
        logger.info("Starting push_sync")
        connection = None
        
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
            connection = get_connection()
            if not connection:
                logger.error("No connection available at push_sync start")
                results['errors'].append('Failed to get database connection')
                return results
            
            cursor = connection.cursor(dictionary=True)
            logger.debug("Connection acquired, starting transaction")
            connection.start_transaction()
            
            for table_name, records in sync_data.items():
                logger.debug(f"Processing table: {table_name} with {len(records)} records")
                
                if not records:
                    continue
                
                results['stats']['total_records'] += len(records)
                synced_ids = []
                
                # Get table columns for filtering
                table_columns = self._get_table_columns(cursor, table_name)
                logger.debug(f"Table {table_name} columns: {table_columns}")
                
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
                            validation = self._validate_bill_for_sync(cursor, record)
                            if not validation['should_sync']:
                                logger.info(f"Bill {record_id} marked as test bill: {validation['reason']}")
                                results['test_bills'].append({
                                    'id': record_id,
                                    'reason': validation['reason']
                                })
                                results['stats']['test_bills'] += 1
                                # Still mark as "synced" locally but don't actually sync to MySQL
                                synced_ids.append(record_id)
                                continue
                        
                        # Filter record to only include existing columns
                        filtered_record = {k: v for k, v in record.items() if k in table_columns}
                        
                        # Convert lists/dicts to JSON strings
                        for key, value in filtered_record.items():
                            if isinstance(value, (list, dict)):
                                filtered_record[key] = json.dumps(value, default=str)
                        
                        logger.debug(f"Checking existence of record ID {record_id} in {table_name}")
                        cursor.execute(f"SELECT * FROM {table_name} WHERE id = %s", (record_id,))
                        existing_record = cursor.fetchone()
                        
                        if existing_record:
                            logger.debug("Record exists in DB, resolving conflicts")
                            winning_record = self.conflict_resolver.resolve_by_rule(table_name, record, existing_record)
                            
                            if winning_record == record:
                                logger.debug(f"Updating record ID {record_id} in {table_name}")
                                self._update_record(cursor, table_name, filtered_record)
                                self._log_to_sync_table(cursor, table_name, record_id, 'UPDATE', record)
                                synced_ids.append(record_id)
                                results['stats']['synced'] += 1
                            else:
                                logger.info(f"DB record is newer for {table_name} ID {record_id}, skipping update")
                                synced_ids.append(record_id)
                        else:
                            logger.debug(f"Inserting new record ID {record_id} into {table_name}")
                            self._insert_record(cursor, table_name, filtered_record)
                            self._log_to_sync_table(cursor, table_name, record_id, 'CREATE', record)
                            synced_ids.append(record_id)
                            results['stats']['synced'] += 1
                    
                    except Exception as e:
                        logger.error(f"Error syncing record {record_id} in {table_name}: {e}\n{traceback.format_exc()}")
                        results['errors'].append(f"{table_name}.{record_id}: {e}")
                        results['stats']['failed'] += 1
                
                results['synced_ids'][table_name] = synced_ids
            
            connection.commit()
            logger.info(f"push_sync success with {results['stats']['synced']} records synced, {results['stats']['test_bills']} test bills skipped")
            results['success'] = True
        
        except Error as e:
            if connection:
                connection.rollback()
            logger.error(f"MySQL error during push_sync: {e}\n{traceback.format_exc()}")
            results['errors'].append(f"Database error: {e}")
        
        except Exception as e:
            if connection:
                connection.rollback()
            logger.error(f"General error during push_sync: {e}\n{traceback.format_exc()}")
            results['errors'].append(f"Sync error: {e}")
        
        finally:
            if connection:
                connection.close()
            logger.info("Finishing push_sync")
        
        return results
    
    def pull_sync(self, last_sync: Optional[str], tables: Optional[List[str]] = None) -> Dict[str, Any]:
        """
        Pull updates from MySQL since last sync (delta sync)
        """
        logger.info("Starting pull_sync")
        connection = None
        
        results = {
            'success': False,
            'data': {},
            'errors': [],
            'sync_timestamp': datetime.now().isoformat()
        }
        
        # Default tables to sync
        if tables is None:
            tables = ['Products', 'Customers', 'Users', 'Stores', 'SystemSettings', 'BillFormats', 'Returns', 'Notifications']
        
        try:
            connection = get_connection()
            if not connection:
                logger.error("No connection available at pull_sync start")
                results['errors'].append('Failed to get database connection')
                return results
            
            cursor = connection.cursor(dictionary=True)
            
            for table_name in tables:
                logger.debug(f"Pull syncing table {table_name}")
                
                try:
                    # Get table columns
                    columns = self._get_table_columns(cursor, table_name)
                    
                    # Build ORDER BY clause
                    order_by_clause = ""
                    if 'updatedAt' in columns:
                        order_by_clause = "ORDER BY updatedAt DESC"
                    elif 'createdAt' in columns:
                        order_by_clause = "ORDER BY createdAt DESC"
                    elif 'created_at' in columns:
                        order_by_clause = "ORDER BY created_at DESC"
                    
                    # Build query for delta sync
                    if last_sync:
                        if 'updatedAt' in columns and 'createdAt' in columns:
                            query = f"SELECT * FROM {table_name} WHERE updatedAt > %s OR createdAt > %s {order_by_clause}"
                            params = (last_sync, last_sync)
                        elif 'updatedAt' in columns:
                            query = f"SELECT * FROM {table_name} WHERE updatedAt > %s {order_by_clause}"
                            params = (last_sync,)
                        elif 'createdAt' in columns:
                            query = f"SELECT * FROM {table_name} WHERE createdAt > %s {order_by_clause}"
                            params = (last_sync,)
                        elif 'created_at' in columns:
                            query = f"SELECT * FROM {table_name} WHERE created_at > %s {order_by_clause}"
                            params = (last_sync,)
                        else:
                            # No timestamp columns for delta sync, pull all
                            query = f"SELECT * FROM {table_name} {order_by_clause}"
                            params = None
                    else:
                        # First sync - get all records
                        query = f"SELECT * FROM {table_name} {order_by_clause}"
                        params = None
                    
                    logger.debug(f"Executing query: {query.strip()}")
                    if params:
                        logger.debug(f"Query parameters: {params}")
                        cursor.execute(query, params)
                    else:
                        cursor.execute(query)
                    
                    records = cursor.fetchall()
                    logger.debug(f"Fetched {len(records)} records from {table_name}")
                    
                    # Convert to JSON-serializable format
                    serialized_records = []
                    for record in records:
                        serialized_record = {}
                        for key, value in record.items():
                            if isinstance(value, (datetime, date)):
                                serialized_record[key] = value.isoformat()
                            elif isinstance(value, Decimal):
                                serialized_record[key] = float(value)
                            else:
                                serialized_record[key] = value
                        serialized_records.append(serialized_record)
                    
                    results['data'][table_name] = serialized_records
                    logger.info(f"Completed pull sync on table {table_name} with {len(serialized_records)} records")
                
                except Error as e:
                    logger.error(f"MySQL error on pull sync table {table_name}: {e}\n{traceback.format_exc()}")
                    results['errors'].append(f"{table_name}: MySQL Error - {e}")
                
                except Exception as e:
                    logger.error(f"General error on pull sync table {table_name}: {e}\n{traceback.format_exc()}")
                    results['errors'].append(f"{table_name}: General Error - {e}")
            
            results['success'] = True
            logger.info("Finished pull_sync")
        
        except Error as e:
            logger.error(f"MySQL error during pull_sync: {e}\n{traceback.format_exc()}")
            results['errors'].append(f"Database error: {e}")
        
        except Exception as e:
            logger.error(f"General error during pull_sync: {e}\n{traceback.format_exc()}")
            results['errors'].append(f"Sync error: {e}")
        
        finally:
            if connection:
                connection.close()
        
        return results
    
    def _insert_record(self, cursor, table_name: str, record: Dict):
        """Insert a new record into MySQL"""
        logger.debug(f"Inserting record {record.get('id')} into {table_name}")
        
        columns = list(record.keys())
        placeholders = ['%s'] * len(record)
        values = list(record.values())
        
        query = f"INSERT INTO {table_name} ({', '.join(columns)}) VALUES ({', '.join(placeholders)})"
        cursor.execute(query, values)
        logger.debug(f"Inserted record {record.get('id')} into {table_name}")
    
    def _update_record(self, cursor, table_name: str, record: Dict):
        """Update an existing record in MySQL"""
        logger.debug(f"Updating record {record.get('id')} in {table_name}")
        
        record_id = record['id']
        set_parts = []
        values = []
        
        for k, v in record.items():
            if k != 'id':
                set_parts.append(f"{k} = %s")
                values.append(v)
        
        values.append(record_id)
        query = f"UPDATE {table_name} SET {', '.join(set_parts)} WHERE id = %s"
        cursor.execute(query, values)
        logger.debug(f"Updated record {record.get('id')} in {table_name}")
    
    def queue_for_sync(self, table_name, record, change_type="INSERT"):
        """
        Immediately sync a record to MySQL (used by billing app)
        with foreign key validation and sync_table logging
        """
        connection = None
        try:
            connection = get_connection()
            if not connection:
                logger.error("No connection available for immediate sync")
                return False
            
            cursor = connection.cursor(dictionary=True)
            
            try:
                connection.start_transaction()
                
                # CRITICAL: Validate foreign key dependencies BEFORE insert
                if change_type == "INSERT":
                    if table_name == "Bills":
                        # Check if customer exists (if customerId is not null)
                        customer_id = record.get('customerId')
                        if customer_id:
                            cursor.execute("SELECT id FROM Customers WHERE id = %s", (customer_id,))
                            if not cursor.fetchone():
                                logger.error(f"Cannot insert Bill: Customer {customer_id} does not exist")
                                connection.rollback()
                                return False
                    
                    elif table_name == "BillItems":
                        # Check if bill exists
                        bill_id = record.get('billId')
                        if bill_id:
                            cursor.execute("SELECT id FROM Bills WHERE id = %s", (bill_id,))
                            if not cursor.fetchone():
                                logger.error(f"Cannot insert BillItem: Bill {bill_id} does not exist")
                                connection.rollback()
                                return False
                
                # Get table columns for validation
                table_columns = self._get_table_columns(cursor, table_name)
                filtered_record = {k: v for k, v in record.items() if k in table_columns}
                
                # Serialize lists and dicts as JSON
                for key, value in filtered_record.items():
                    if isinstance(value, (list, dict)):
                        filtered_record[key] = json.dumps(value, default=str)
                
                record_id = filtered_record.get('id') or filtered_record.get('return_id')
                
                # Perform the actual data operation
                if change_type == "INSERT":
                    self._insert_record(cursor, table_name, filtered_record)
                    logger.info(f"Queued and synced INSERT for {table_name}: {record_id}")
                elif change_type == "UPDATE":
                    self._update_record(cursor, table_name, filtered_record)
                    logger.info(f"Queued and synced UPDATE for {table_name}: {record_id}")
                
                # CRITICAL FIX: Log the change to sync_table for tracking
                self._log_to_sync_table(
                    cursor=cursor,
                    table_name=table_name,
                    record_id=record_id,
                    operation_type='CREATE' if change_type == 'INSERT' else 'UPDATE',
                    change_data=record,  # Store original record with all fields
                    source='local',
                    status='synced'
                )
                
                connection.commit()
                return True
            
            except Exception as e:
                connection.rollback()
                logger.error(f"Error in queue_for_sync: {e}\n{traceback.format_exc()}")
                
                # Try to log failed sync attempt to sync_table
                try:
                    connection.start_transaction()
                    self._log_to_sync_table(
                        cursor=cursor,
                        table_name=table_name,
                        record_id=record.get('id', 'unknown'),
                        operation_type='CREATE' if change_type == 'INSERT' else 'UPDATE',
                        change_data=record,
                        source='local',
                        status='failed'
                    )
                    connection.commit()
                except Exception as log_error:
                    logger.error(f"Failed to log error to sync_table: {log_error}")
                    connection.rollback()
                
                return False
            
            finally:
                if connection.is_connected():
                    cursor.close()
        
        except Exception as e:
            logger.error(f"Error getting connection for queue_for_sync: {e}")
            return False
        
        finally:
            if connection and connection.is_connected():
                connection.close()
    
    def get_sync_status(self) -> Dict[str, Any]:
        """Get current sync system status"""
        logger.debug("Getting sync status")
        connection = None
        
        try:
            connection = get_connection()
            if not connection:
                return {
                    'status': 'offline',
                    'message': 'Database connection unavailable'
                }
            
            cursor = connection.cursor(dictionary=True)
            
            # Try to get last sync time from sync_table
            try:
                logger.debug("Querying sync_table for last sync status")
                cursor.execute("""
                    SELECT created_at, operation_type, status
                    FROM sync_table
                    ORDER BY created_at DESC
                    LIMIT 1
                """)
                last_sync = cursor.fetchone()
                logger.debug(f"Last sync log fetched: {last_sync}")
            except Exception as e:
                logger.debug(f"Error fetching last sync log: {e}")
                last_sync = None
            
            return {
                'status': 'online',
                'database_connected': True,
                'last_sync': last_sync.get('created_at').isoformat() if last_sync and last_sync.get('created_at') else None,
                'last_sync_type': last_sync.get('operation_type') if last_sync else None,
                'last_sync_status': last_sync.get('status') if last_sync else None
            }
        
        except Exception as e:
            logger.error(f"Error getting sync status: {e}\n{traceback.format_exc()}")
            return {
                'status': 'error',
                'message': str(e)
            }
        
        finally:
            if connection:
                connection.close()
