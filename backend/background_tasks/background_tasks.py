import time
import threading
import os
from flask import Flask
from config.config import (
    PRODUCTS_FILE, CUSTOMERS_FILE, USERS_FILE, STORES_FILE, SYSTEM_SETTINGS_FILE, RETURNS_FILE, BILLS_FILE, BILL_FORMATS_FILE
)
from helpers.utils import write_json_file, read_json_file
from utils.sync_controller import SyncController # Global instance is fine as it manages client pool

# Map table names to their corresponding file paths
TABLE_FILE_MAP = {
    'Products': PRODUCTS_FILE,
    'Customers': CUSTOMERS_FILE,
    'Users': USERS_FILE,
    'Stores': STORES_FILE,
    'SystemSettings': SYSTEM_SETTINGS_FILE,
    'Returns': RETURNS_FILE,
    'Bills': BILLS_FILE,
    'BillFormats': BILL_FORMATS_FILE,
}

# Store last sync timestamp for each table (for pull sync from Supabase)
last_sync_timestamps = {table: None for table in TABLE_FILE_MAP.keys()}

# Global SyncController instance
sync_controller = SyncController()

def initial_full_sync(app: Flask):
    """Perform an initial full sync for any missing JSON files."""
    with app.app_context():
        app.logger.info("Starting initial full sync for missing JSON files.")
        for table_name, file_path in TABLE_FILE_MAP.items():
            if not os.path.exists(file_path):
                app.logger.info(f"JSON file for {table_name} not found at {file_path}. Performing full pull.")
                try:
                    # Perform a full pull for this specific table
                    result = sync_controller.pull_sync(last_sync=None, tables=[table_name])
                    if result['success'] and table_name in result['data'] and result['data'][table_name]:
                        records = result['data'][table_name]
                        if table_name == 'SystemSettings':
                            # SystemSettings is expected to be a single object, not a list
                            write_json_file(file_path, records[0] if records else {})
                        else:
                            write_json_file(file_path, records)
                        app.logger.info(f"Successfully performed full pull and created {file_path} for {table_name}.")
                    elif not result['success']:
                        app.logger.error(f"Initial full pull for {table_name} failed: {result['errors']}")
                    else:
                        app.logger.info(f"No data pulled for {table_name} during initial sync. Creating empty file.")
                        write_json_file(file_path, [] if table_name != 'SystemSettings' else {})
                except Exception as e:
                    app.logger.error(f"Error during initial full pull for {table_name}: {e}")
            else:
                app.logger.info(f"JSON file for {table_name} already exists at {file_path}. Skipping initial full pull.")
        app.logger.info("Initial full sync completed.")

def background_pull_sync_scheduler(app: Flask, interval_minutes=5):
    """Periodically pull updates from Supabase (primary source) to local JSON files (backup)"""
    with app.app_context():
        # Perform initial full sync once at startup
        initial_full_sync(app)

        while True:
            app.logger.info(f"Background pull sync starting. Next sync in {interval_minutes} minutes.")
            try:
                # We need to iterate through each table to pass its specific last_sync_timestamp
                for table_name, file_path in TABLE_FILE_MAP.items():
                    current_last_sync = last_sync_timestamps[table_name]
                    app.logger.debug(f"Delta pull for {table_name} with last_sync: {current_last_sync}")
                    
                    result = sync_controller.pull_sync(last_sync=current_last_sync, tables=[table_name])
                    
                    if result['success']:
                        app.logger.info(f"Delta pull sync for {table_name} completed successfully.")
                        pulled_records = result.get('data', {}).get(table_name, [])
                        
                        if pulled_records:
                            app.logger.info(f"Found {len(pulled_records)} new/updated records for {table_name}.")
                            
                            # Read existing data
                            existing_data = read_json_file(file_path, default_value=[] if table_name != 'SystemSettings' else {})
                            
                            # Convert existing_data to a dictionary for easier merging by ID
                            if isinstance(existing_data, list):
                                existing_data_map = {record.get('id'): record for record in existing_data if record.get('id')}
                            else: # For SystemSettings, it's an object
                                existing_data_map = {existing_data.get('id'): existing_data} if existing_data.get('id') else {}
                            
                            # Merge new/updated records
                            for record in pulled_records:
                                record_id = record.get('id')
                                if record_id:
                                    existing_data_map[record_id] = record
                            
                            # Convert back to list if it was originally a list
                            if table_name != 'SystemSettings':
                                merged_data = list(existing_data_map.values())
                            else:
                                merged_data = list(existing_data_map.values())[0] if existing_data_map else {}
                            
                            write_json_file(file_path, merged_data)
                            app.logger.info(f"Merged and updated {file_path} for {table_name}.")
                        else:
                            app.logger.info(f"No new records for {table_name} during delta pull.")
                        
                        # Update last sync timestamp for this table
                        last_sync_timestamps[table_name] = result['sync_timestamp']
                    else:
                        app.logger.error(f"Delta pull sync for {table_name} failed: {result['errors']}")
            except Exception as e:
                app.logger.error(f"Error during background pull sync: {e}")
            
            time.sleep(interval_minutes * 60)

def background_json_to_supabase_sync_scheduler(app: Flask, interval_minutes=5):
    """Periodically push data from local JSON files (backup) to Supabase (primary)"""
    with app.app_context():
        app.logger.info("Starting background JSON to Supabase push sync scheduler.")
        while True:
            app.logger.info(f"Background JSON to Supabase push sync starting. Next push in {interval_minutes} minutes.")
            full_sync_data = {}
            
            for table_name, file_path in TABLE_FILE_MAP.items():
                if os.path.exists(file_path):
                    try:
                        data = read_json_file(file_path, default_value=[] if table_name != 'SystemSettings' else {})
                        if data:
                            # push_sync expects a list of records for all table types
                            if table_name == 'SystemSettings' and isinstance(data, dict):
                                full_sync_data[table_name] = [data]
                            elif isinstance(data, list):
                                full_sync_data[table_name] = data
                            else:
                                app.logger.warning(f"Unexpected data format in {file_path} for {table_name}. Skipping for push sync.")
                                continue
                    except Exception as e:
                        app.logger.error(f"Error reading JSON file {file_path} for push sync: {e}")
                else:
                    app.logger.debug(f"JSON file for {table_name} not found at {file_path}. Skipping for push sync.")
            
            if full_sync_data:
                try:
                    push_results = sync_controller.push_sync(full_sync_data)
                    if push_results['success']:
                        app.logger.info(f"Background JSON to Supabase push sync completed successfully. Stats: {push_results['stats']}")
                    else:
                        app.logger.error(f"Background JSON to Supabase push sync failed with errors: {push_results['errors']}")
                except Exception as e:
                    app.logger.error(f"Error during background JSON to Supabase push sync: {e}")
            else:
                app.logger.info("No data found in JSON files to push to Supabase.")
            
            time.sleep(interval_minutes * 60)

def start_background_tasks(app: Flask):
    """Starts all background tasks."""
    # Pull sync (Supabase to JSON)
    pull_scheduler_thread = threading.Thread(
        target=background_pull_sync_scheduler, daemon=True, args=(app, 5,)
    )
    pull_scheduler_thread.start()
    app.logger.info("Background pull sync scheduler (Supabase -> JSON) started.")

    # Push sync (JSON to Supabase)
    json_push_scheduler_thread = threading.Thread(
        target=background_json_to_supabase_sync_scheduler, daemon=True, args=(app, 5,)
    )
    json_push_scheduler_thread.start()
    app.logger.info("Background JSON to Supabase push sync scheduler (JSON -> Supabase) started.")
