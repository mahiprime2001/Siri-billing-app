import unittest
from unittest.mock import patch, MagicMock
import os
import sys
import time
from datetime import datetime, timedelta, timezone

# Adjust the path to import modules from the parent directory
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from backend.background_tasks.background_tasks import (
    background_pull_sync_scheduler, 
    background_json_to_supabase_sync_scheduler, 
    TABLE_FILE_MAP,
    last_sync_timestamps # We need to reset this for tests
)
# from utils.sync_controller import SyncController # Mock this directly
# from helpers.utils import read_json_file, write_json_file # Mock these

class TestBackgroundTasks(unittest.TestCase):

    def setUp(self):
        # Reset last_sync_timestamps before each test
        for table in last_sync_timestamps:
            last_sync_timestamps[table] = None
        
        self.mock_app = MagicMock()
        self.mock_app.app_context.return_value.__enter__.return_value = self.mock_app
        self.mock_app.logger = MagicMock() # Mock logger calls
        
        # Mock global SyncController instance
        self.mock_sync_controller = MagicMock()
        
        # Patch the global sync_controller with our mock
        patcher = patch('backend.background_tasks.background_tasks.sync_controller', self.mock_sync_controller)
        self.addCleanup(patcher.stop)
        patcher.start()

        # Patch file operations
        self.mock_read_json_file_patch = patch('backend.background_tasks.background_tasks.read_json_file')
        self.mock_write_json_file_patch = patch('backend.background_tasks.background_tasks.write_json_file')
        self.mock_os_path_exists_patch = patch('backend.background_tasks.background_tasks.os.path.exists')
        
        self.mock_read_json_file = self.mock_read_json_file_patch.start()
        self.mock_write_json_file = self.mock_write_json_file_patch.start()
        self.mock_os_path_exists = self.mock_os_path_exists_patch.start()

        self.addCleanup(self.mock_read_json_file_patch.stop)
        self.addCleanup(self.mock_write_json_file_patch.stop)
        self.addCleanup(self.mock_os_path_exists_patch.stop)


    @patch('time.sleep', return_value=None) # Mock time.sleep to avoid actual delays
    def test_background_pull_sync_scheduler(self, mock_sleep):
        # Configure mocks for pull sync
        self.mock_sync_controller.pull_sync.return_value = {
            'success': True,
            'data': {'Products': [{'id': 'p1', 'name': 'Product A', 'updatedAt': datetime.now(timezone.utc).isoformat()}]},
            'sync_timestamp': datetime.now(timezone.utc).isoformat()
        }
        self.mock_os_path_exists.return_value = True # Assume JSON files exist initially
        self.mock_read_json_file.return_value = [] # Start with empty local JSON
        
        # Run the scheduler once (simulated by mocking time.sleep)
        with patch('backend.background_tasks.background_tasks.initial_full_sync'): # Don't run initial full sync
            background_pull_sync_scheduler(self.mock_app, interval_minutes=0.01) # Small interval for single run

        self.mock_sync_controller.pull_sync.assert_called_once()
        self.mock_write_json_file.assert_called_once() # Should write merged data
        self.mock_app.logger.info.assert_any_call("Delta pull sync for Products completed successfully.")
        self.assertIsNotNone(last_sync_timestamps['Products'])

    @patch('time.sleep', return_value=None) # Mock time.sleep to avoid actual delays
    def test_background_json_to_supabase_sync_scheduler(self, mock_sleep):
        # Configure mocks for push sync
        self.mock_os_path_exists.return_value = True # Assume JSON files exist
        self.mock_read_json_file.return_value = [{'id': 'p1', 'name': 'Product A'}] # Simulate data in JSON
        self.mock_sync_controller.push_sync.return_value = {
            'success': True,
            'synced_ids': {'Products': ['p1']},
            'errors': [],
            'test_bills': [],
            'stats': {'total_records': 1, 'synced': 1, 'failed': 0, 'test_bills': 0}
        }
        
        # Run the scheduler once (simulated by mocking time.sleep)
        background_json_to_supabase_sync_scheduler(self.mock_app, interval_minutes=0.01)

        self.mock_read_json_file.assert_called_once() # Should read Products JSON
        self.mock_sync_controller.push_sync.assert_called_once()
        self.mock_app.logger.info.assert_any_call("Background JSON to Supabase push sync completed successfully. Stats: {'total_records': 1, 'synced': 1, 'failed': 0, 'test_bills': 0}")

if __name__ == '__main__':
    unittest.main()
