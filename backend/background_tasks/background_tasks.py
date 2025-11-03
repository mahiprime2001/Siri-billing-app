import time
import threading
from flask import Flask

from config.config import (
    PRODUCTS_FILE, CUSTOMERS_FILE, USERS_FILE, STORES_FILE, SYSTEM_SETTINGS_FILE
)
from helpers.utils import write_json_file
from utils.sync_controller import SyncController

sync_controller = SyncController()

def background_pull_sync_scheduler(app: Flask, interval_minutes=5):
    """Periodically pull updates from MySQL"""
    with app.app_context():
        while True:
            app.logger.info(f"Background pull sync starting. Next sync in {interval_minutes} minutes.")
            try:
                result = sync_controller.pull_sync(last_sync=None)
                if result['success']:
                    app.logger.info("Background pull sync completed successfully.")
                    
                    # Update local JSON files with pulled data
                    for table_name, records in result.get('data', {}).items():
                        if table_name == 'Products' and records:
                            write_json_file(PRODUCTS_FILE, records)
                        elif table_name == 'Customers' and records:
                            write_json_file(CUSTOMERS_FILE, records)
                        elif table_name == 'Users' and records:
                            write_json_file(USERS_FILE, records)
                        elif table_name == 'Stores' and records:
                            write_json_file(STORES_FILE, records)
                        elif table_name == 'SystemSettings' and records and len(records) > 0:
                            write_json_file(SYSTEM_SETTINGS_FILE, records[0])
                else:
                    app.logger.error(f"Background pull sync failed: {result['errors']}")
            except Exception as e:
                app.logger.error(f"Error during background pull sync: {e}")
            
            time.sleep(interval_minutes * 60)

def start_background_tasks(app: Flask):
    """Starts all background tasks."""
    pull_scheduler_thread = threading.Thread(
        target=background_pull_sync_scheduler, daemon=True, args=(app, 5,)
    )
    pull_scheduler_thread.start()
    app.logger.info("Background pull sync scheduler started.")
