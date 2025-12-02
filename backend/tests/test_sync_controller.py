import unittest
from unittest.mock import patch, MagicMock
import os
import sys
import json
from datetime import datetime, timedelta, timezone

# Adjust the path to import modules from the parent directory
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from utils.sync_controller import SyncController, ConflictResolver
from supabase import Client # For type hinting

class TestSyncController(unittest.TestCase):

    def setUp(self):
        self.sync_controller = SyncController()
        self.mock_supabase = MagicMock(spec=Client)

    @patch('utils.connection_pool.get_supabase_client')
    def test_pull_sync_success(self, mock_get_supabase_client):
        mock_get_supabase_client.return_value = self.mock_supabase
        
        mock_from = MagicMock()
        self.mock_supabase.from_.return_value = mock_from
        
        # Simulate Supabase returning data
        mock_from.select.return_value.or_.return_value.order.return_value.execute.return_value.data = [
            {'id': 'prod1', 'name': 'Product A', 'updatedAt': datetime.now(timezone.utc).isoformat()},
            {'id': 'prod2', 'name': 'Product B', 'updatedAt': datetime.now(timezone.utc).isoformat()}
        ]
        
        tables_to_sync = ['Products']
        result = self.sync_controller.pull_sync(last_sync=None, tables=tables_to_sync)
        
        self.assertTrue(result['success'])
        self.assertIn('Products', result['data'])
        self.assertEqual(len(result['data']['Products']), 2)
        self.assertIsNotNone(result['sync_timestamp'])
        
        mock_from.select.assert_called_once_with('*')
        mock_from.select.return_value.or_.assert_called_once() # Called if last_sync is not None, or if last_sync is None, then just .order() is called directly.
        
    @patch('utils.connection_pool.get_supabase_client')
    def test_pull_sync_no_new_records(self, mock_get_supabase_client):
        mock_get_supabase_client.return_value = self.mock_supabase
        
        mock_from = MagicMock()
        self.mock_supabase.from_.return_value = mock_from
        
        # Simulate Supabase returning no new data
        mock_from.select.return_value.or_.return_value.order.return_value.execute.return_value.data = []
        mock_from.select.return_value.or_.return_value.order.return_value.execute.return_value.status_code = 200 # Indicate success
        
        tables_to_sync = ['Products']
        result = self.sync_controller.pull_sync(last_sync=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat(), tables=tables_to_sync)
        
        self.assertTrue(result['success'])
        self.assertIn('Products', result['data'])
        self.assertEqual(len(result['data']['Products']), 0)

    @patch('utils.connection_pool.get_supabase_client')
    def test_push_sync_insert_new_record(self, mock_get_supabase_client):
        mock_get_supabase_client.return_value = self.mock_supabase
        
        mock_from = MagicMock()
        self.mock_supabase.from_.return_value = mock_from
        
        # Simulate record not existing in Supabase
        mock_from.select.return_value.eq.return_value.execute.return_value.data = []
        # Simulate successful insert
        mock_from.insert.return_value.execute.return_value.data = [{'id': 'new_prod_1'}]
        # Mock logging to sync table
        mock_from.insert.return_value.execute.return_value.data = [{'id': 1}] # For sync_table logging

        sync_data = {
            'Products': [{'id': 'new_prod_1', 'name': 'New Product', 'updatedAt': datetime.now(timezone.utc).isoformat()}]
        }
        
        result = self.sync_controller.push_sync(sync_data)
        
        self.assertTrue(result['success'])
        self.assertEqual(result['stats']['synced'], 1)
        mock_from.select.assert_called_once() # Check for existing record
        mock_from.insert.assert_called_once() # Should insert new record
        
    @patch('utils.connection_pool.get_supabase_client')
    def test_push_sync_update_existing_record_local_wins(self, mock_get_supabase_client):
        mock_get_supabase_client.return_value = self.mock_supabase
        
        mock_from = MagicMock()
        self.mock_supabase.from_.return_value = mock_from
        
        # Simulate record existing in Supabase (older timestamp)
        old_supabase_timestamp = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        mock_from.select.return_value.eq.return_value.execute.return_value.data = [
            {'id': 'prod_exist', 'name': 'Product Old', 'updatedAt': old_supabase_timestamp}
        ]
        # Simulate successful update
        mock_from.update.return_value.eq.return_value.execute.return_value.data = [{'id': 'prod_exist'}]
        # Mock logging to sync table
        mock_from.insert.return_value.execute.return_value.data = [{'id': 1}] # For sync_table logging

        new_local_timestamp = datetime.now(timezone.utc).isoformat()
        sync_data = {
            'Products': [{'id': 'prod_exist', 'name': 'Product New', 'updatedAt': new_local_timestamp}]
        }
        
        result = self.sync_controller.push_sync(sync_data)
        
        self.assertTrue(result['success'])
        self.assertEqual(result['stats']['synced'], 1)
        mock_from.select.assert_called_once()
        mock_from.update.assert_called_once() # Should update existing record

    @patch('utils.connection_pool.get_supabase_client')
    def test_push_sync_update_existing_record_supabase_wins(self, mock_get_supabase_client):
        mock_get_supabase_client.return_value = self.mock_supabase
        
        mock_from = MagicMock()
        self.mock_supabase.from_.return_value = mock_from
        
        # Simulate record existing in Supabase (newer timestamp)
        new_supabase_timestamp = datetime.now(timezone.utc).isoformat()
        mock_from.select.return_value.eq.return_value.execute.return_value.data = [
            {'id': 'prod_exist', 'name': 'Product Newer', 'updatedAt': new_supabase_timestamp}
        ]
        # Simulate successful update for sync_table logging (not actual record update)
        mock_from.insert.return_value.execute.return_value.data = [{'id': 1}] 

        old_local_timestamp = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        sync_data = {
            'Products': [{'id': 'prod_exist', 'name': 'Product Older', 'updatedAt': old_local_timestamp}]
        }
        
        result = self.sync_controller.push_sync(sync_data)
        
        self.assertTrue(result['success'])
        self.assertEqual(result['stats']['synced'], 1) # Still counted as synced even if no update occurs
        mock_from.select.assert_called_once()
        mock_from.update.assert_not_called() # Should NOT update existing record (Supabase is newer)

    @patch('utils.connection_pool.get_supabase_client')
    def test_push_sync_bill_validation_skip(self, mock_get_supabase_client):
        mock_get_supabase_client.return_value = self.mock_supabase
        
        mock_from = MagicMock()
        self.mock_supabase.from_.return_value = mock_from
        
        # Mock user check
        mock_from.select.return_value.eq.return_value.execute.return_value.data = [] # User does not exist

        sync_data = {
            'Bills': [{'id': 'bill_test', 'createdBy': 'user_nonexistent', 'updatedAt': datetime.now(timezone.utc).isoformat()}]
        }
        
        result = self.sync_controller.push_sync(sync_data)
        
        self.assertTrue(result['success'])
        self.assertEqual(result['stats']['test_bills'], 1)
        self.assertEqual(result['stats']['synced'], 0) # Not actually synced to main table
        self.assertIn('bill_test', [b['id'] for b in result['test_bills']])

class TestConflictResolver(unittest.TestCase):
    
    def test_resolve_by_timestamp_local_newer(self):
        local_record = {'id': '1', 'updatedAt': '2023-01-01T12:00:01Z'}
        supabase_record = {'id': '1', 'updatedAt': '2023-01-01T12:00:00Z'}
        resolved = ConflictResolver.resolve_by_timestamp(local_record, supabase_record)
        self.assertEqual(resolved, local_record)

    def test_resolve_by_timestamp_supabase_newer(self):
        local_record = {'id': '1', 'updatedAt': '2023-01-01T12:00:00Z'}
        supabase_record = {'id': '1', 'updatedAt': '2023-01-01T12:00:01Z'}
        resolved = ConflictResolver.resolve_by_timestamp(local_record, supabase_record)
        self.assertEqual(resolved, supabase_record)

    def test_resolve_by_timestamp_equal(self):
        local_record = {'id': '1', 'updatedAt': '2023-01-01T12:00:00Z'}
        supabase_record = {'id': '1', 'updatedAt': '2023-01-01T12:00:00Z'}
        resolved = ConflictResolver.resolve_by_timestamp(local_record, supabase_record)
        self.assertEqual(resolved, supabase_record) # Default to Supabase on equality

    def test_resolve_by_rule_bills_local_wins(self):
        local_record = {'id': '1', 'updatedAt': '2023-01-01T12:00:00Z'}
        supabase_record = {'id': '1', 'updatedAt': '2023-01-01T12:00:01Z'}
        resolved = ConflictResolver.resolve_by_rule('Bills', local_record, supabase_record)
        self.assertEqual(resolved, local_record)

    def test_resolve_by_rule_other_table_timestamp_wins(self):
        local_record = {'id': '1', 'updatedAt': '2023-01-01T12:00:00Z'}
        supabase_record = {'id': '1', 'updatedAt': '2023-01-01T12:00:01Z'}
        resolved = ConflictResolver.resolve_by_rule('Products', local_record, supabase_record)
        self.assertEqual(resolved, supabase_record)


if __name__ == '__main__':
    unittest.main()
