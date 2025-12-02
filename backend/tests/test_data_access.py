import unittest
from unittest.mock import patch, MagicMock
import os
import sys
from datetime import datetime

# Adjust the path to import modules from the parent directory
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from data_access.data_access import get_or_create_customer, update_product_stock_supabase, save_bill_item
from data_access.supabase_data_access import sync_to_supabase_immediately # Need to mock this
from utils.connection_pool import get_supabase_client
from supabase import Client # For type hinting

class TestDataAccess(unittest.TestCase):

    @patch('utils.connection_pool.get_supabase_client')
    def test_get_or_create_customer_create(self, mock_get_supabase_client):
        # Mock Supabase client and its methods
        mock_supabase = MagicMock(spec=Client)
        mock_get_supabase_client.return_value = mock_supabase
        
        mock_from_customers = MagicMock()
        mock_supabase.from_.return_value = mock_from_customers
        
        # Simulate customer not found (select returns no data)
        mock_from_customers.select.return_value.eq.return_value.execute.return_value.data = []
        
        # Simulate successful insert
        mock_from_customers.insert.return_value.execute.return_value.data = [{'id': 'CUST-test-id'}]

        customer_id = get_or_create_customer(
            customer_name='New Customer', 
            customer_phone='1234567890'
        )
        
        self.assertIsNotNone(customer_id)
        self.assertTrue(customer_id.startswith('CUST-'))
        mock_supabase.from_.assert_called_with('customers')
        mock_from_customers.select.assert_called_once()
        mock_from_customers.insert.assert_called_once()

    @patch('utils.connection_pool.get_supabase_client')
    def test_get_or_create_customer_get_and_update(self, mock_get_supabase_client):
        mock_supabase = MagicMock(spec=Client)
        mock_get_supabase_client.return_value = mock_supabase
        
        mock_from_customers = MagicMock()
        mock_supabase.from_.return_value = mock_from_customers
        
        # Simulate customer found
        mock_from_customers.select.return_value.eq.return_value.execute.return_value.data = [
            {'id': 'CUST-existing', 'name': 'Existing Customer', 'phone': '1234567890'}
        ]
        
        # Simulate successful update
        mock_from_customers.update.return_value.eq.return_value.execute.return_value.data = [{'id': 'CUST-existing'}]

        customer_id = get_or_create_customer(
            customer_name='Updated Customer', 
            customer_phone='1234567890'
        )
        
        self.assertEqual(customer_id, 'CUST-existing')
        mock_from_customers.select.assert_called_once()
        mock_from_customers.update.assert_called_once()

    @patch('utils.connection_pool.get_supabase_client')
    def test_update_product_stock_supabase_success(self, mock_get_supabase_client):
        mock_supabase = MagicMock(spec=Client)
        mock_get_supabase_client.return_value = mock_supabase

        mock_from_products = MagicMock()
        mock_supabase.from_.return_value = mock_from_products

        # Simulate product found and stock fetched
        mock_from_products.select.return_value.eq.return_value.execute.return_value.data = [{'id': 'PROD-1', 'stock': 10}]
        # Simulate successful update
        mock_from_products.update.return_value.eq.return_value.execute.return_value.data = [{'id': 'PROD-1', 'stock': 8}]

        result = update_product_stock_supabase(product_id='PROD-1', quantity_sold=2)
        
        self.assertTrue(result)
        mock_from_products.select.assert_called_once()
        mock_from_products.update.assert_called_once()
        # Verify the stock was updated correctly
        mock_from_products.update.return_value.eq.assert_called_once_with('id', 'PROD-1')
        update_args, _ = mock_from_products.update.call_args
        self.assertEqual(update_args[0]['stock'], 8)

    @patch('utils.connection_pool.get_supabase_client')
    def test_update_product_stock_supabase_product_not_found(self, mock_get_supabase_client):
        mock_supabase = MagicMock(spec=Client)
        mock_get_supabase_client.return_value = mock_supabase

        mock_from_products = MagicMock()
        mock_supabase.from_.return_value = mock_from_products

        # Simulate product not found
        mock_from_products.select.return_value.eq.return_value.execute.return_value.data = []

        result = update_product_stock_supabase(product_id='PROD-nonexistent', quantity_sold=1)
        
        self.assertFalse(result)
        mock_from_products.select.assert_called_once()
        mock_from_products.update.assert_not_called()

    @patch('data_access.data_access.sync_to_supabase_immediately')
    def test_save_bill_item_success(self, mock_sync_to_supabase_immediately):
        mock_sync_to_supabase_immediately.return_value = True

        bill_item = {
            'id': 'ITEM-123',
            'billId': 'BILL-XYZ',
            'productId': 'PROD-ABC',
            'quantity': 1,
            'price': 100.0
        }
        result = save_bill_item(bill_item)
        
        self.assertTrue(result)
        mock_sync_to_supabase_immediately.assert_called_once_with('billitems', bill_item, 'INSERT')

    @patch('data_access.data_access.sync_to_supabase_immediately')
    def test_save_bill_item_failure(self, mock_sync_to_supabase_immediately):
        mock_sync_to_supabase_immediately.return_value = False

        bill_item = {
            'id': 'ITEM-456',
            'billId': 'BILL-PQR',
            'productId': 'PROD-DEF',
            'quantity': 2,
            'price': 50.0
        }
        result = save_bill_item(bill_item)
        
        self.assertFalse(result)
        mock_sync_to_supabase_immediately.assert_called_once_with('billitems', bill_item, 'INSERT')

if __name__ == '__main__':
    unittest.main()
