import os
import json
import unittest
from datetime import datetime, timedelta
import time
import uuid

# Adjust the path to import from the utils directory
import sys
from utils.sync_queue import add_to_sync_queue, get_pending_syncs, mark_sync_done, SYNC_QUEUE_FILE, write_sync_queue, read_sync_queue

class TestSyncQueueFunctions(unittest.TestCase):

    def setUp(self):
        """Set up for test: ensure a clean sync_queue.json before each test."""
        if os.path.exists(SYNC_QUEUE_FILE):
            os.remove(SYNC_QUEUE_FILE)
        # Ensure the directory exists
        os.makedirs(os.path.dirname(SYNC_QUEUE_FILE), exist_ok=True)
        write_sync_queue([]) # Start with an empty queue

    def tearDown(self):
        """Clean up after test: remove the sync_queue.json file."""
        if os.path.exists(SYNC_QUEUE_FILE):
            os.remove(SYNC_QUEUE_FILE)

    def test_add_to_sync_queue(self):
        """Test adding a single record to the sync queue."""
        table_name = "Users"
        record_data = {"id": "user123", "name": "Test User"}
        add_to_sync_queue(table_name, record_data)

        queue = read_sync_queue()
        self.assertEqual(len(queue), 1)
        entry = queue[0]
        self.assertEqual(entry['table_name'], table_name)
        self.assertEqual(entry['record_data'], record_data)
        self.assertEqual(entry['status'], 'pending')
        self.assertEqual(entry['change_type'], 'INSERT')
        self.assertIn('id', entry)
        self.assertIn('queued_at', entry)
        
        # Test with a different change_type
        table_name_update = "Products"
        record_data_update = {"id": "prod456", "name": "Updated Product"}
        add_to_sync_queue(table_name_update, record_data_update, change_type="UPDATE")
        queue = read_sync_queue()
        self.assertEqual(len(queue), 2)
        entry_update = queue[1]
        self.assertEqual(entry_update['change_type'], 'UPDATE')

    def test_get_pending_syncs(self):
        """Test retrieving only pending sync items."""
        add_to_sync_queue("Users", {"id": "user1", "name": "User One"})
        add_to_sync_queue("Products", {"id": "prod1", "name": "Product One"})

        # Manually mark one as completed to test filtering
        queue = read_sync_queue()
        queue[0]['status'] = 'completed'
        queue[0]['synced_at'] = datetime.now().isoformat()
        write_sync_queue(queue)

        pending_syncs = get_pending_syncs()
        self.assertEqual(len(pending_syncs), 1)
        self.assertEqual(pending_syncs[0]['record_data']['id'], 'prod1')
        self.assertEqual(pending_syncs[0]['status'], 'pending')

    def test_mark_sync_done(self):
        """Test marking a sync item as completed."""
        add_to_sync_queue("Users", {"id": "user1", "name": "User One"})
        queue = read_sync_queue()
        sync_id = queue[0]['id']

        success = mark_sync_done(sync_id)
        self.assertTrue(success)

        updated_queue = read_sync_queue()
        self.assertEqual(updated_queue[0]['status'], 'completed')
        self.assertIn('synced_at', updated_queue[0])

        # Test marking a non-existent sync ID
        success = mark_sync_done("non-existent-id")
        self.assertFalse(success)

    def test_multiple_adds_and_gets(self):
        """Test adding multiple items and then retrieving them."""
        add_to_sync_queue("TableA", {"id": "rec1"})
        add_to_sync_queue("TableB", {"id": "rec2"})
        add_to_sync_queue("TableC", {"id": "rec3"})

        pending = get_pending_syncs()
        self.assertEqual(len(pending), 3)
        self.assertEqual(pending[0]['record_data']['id'], 'rec1')
        self.assertEqual(pending[1]['record_data']['id'], 'rec2')
        self.assertEqual(pending[2]['record_data']['id'], 'rec3')

        mark_sync_done(pending[1]['id']) # Mark rec2 as done

        pending_after_mark = get_pending_syncs()
        self.assertEqual(len(pending_after_mark), 2)
        self.assertEqual(pending_after_mark[0]['record_data']['id'], 'rec1')
        self.assertEqual(pending_after_mark[1]['record_data']['id'], 'rec3')

if __name__ == '__main__':
    unittest.main()
