import uuid
from datetime import datetime
from flask import Blueprint, jsonify, request, g, current_app as app

from auth.auth import session_required # Changed from token_required
from data_access.data_access import get_bills_data, save_bills_data, get_products_data, save_products_data, get_or_create_customer, update_product_stock_supabase, save_bill_item
from data_access.supabase_data_access import (
    sync_to_supabase_immediately, check_user_exists_supabase, check_customer_exists_supabase
)
from notifications.notifications import create_notification
from utils.connection_pool import get_supabase_client
from supabase import Client
import traceback

billing_bp = Blueprint('billing_bp', __name__)
@billing_bp.route('/bills', methods=['POST'])
@billing_bp.route('/billing/save', methods=['POST']) # Add this route to handle frontend requests
@session_required
def create_bill():
    """Create a new bill"""
    try:
        data = request.json
        
        # Get or create customer
        customer_id = get_or_create_customer(
            customer_name=data.get('customerName', 'Walk-in Customer'),
            customer_phone=data.get('customerPhone', ''),
            customer_email=data.get('customerEmail', ''),
            customer_address=data.get('customerAddress', '')
        )
        
        if not customer_id:
            return jsonify({"error": "Failed to create/get customer"}), 500
        
        # Continue with bill creation...
        # Now you can store only customerId in the Bills table
        
        # ... rest of your bill creation logic
        
        raw_bill_data = request.json
        if not raw_bill_data:
            return jsonify({"error": "No bill data provided"}), 400

        # Extract items for separate syncing
        items = raw_bill_data.pop('items', [])
        
        # Initialize bill_data with expected fields from the Bills table schema
        bill_id = raw_bill_data.get('id') or str(uuid.uuid4())
        created_by = raw_bill_data.get('createdBy') or g.current_user['id']

        if not check_user_exists_supabase(created_by):
            return jsonify({"error": f"User {created_by} does not exist"}), 400
        
        bill_data = {
            'id': bill_id,
            'storeid': raw_bill_data.get('storeId'),
            'storename': raw_bill_data.get('storeName'),
            'storeaddress': raw_bill_data.get('storeAddress'),
            'customername': raw_bill_data.get('customerName', 'Walk-in Customer'),
            'customerphone': raw_bill_data.get('customerPhone', ''),
            'customeremail': raw_bill_data.get('customerEmail', ''),
            'customeraddress': raw_bill_data.get('customerAddress', ''),
            'customerid': customer_id, # Set from get_or_create_customer
            'subtotal': float(raw_bill_data.get('subtotal')) if raw_bill_data.get('subtotal') is not None else None,
            'taxpercentage': float(raw_bill_data.get('taxPercentage')) if raw_bill_data.get('taxPercentage') is not None else None,
            'taxamount': float(raw_bill_data.get('taxAmount')) if raw_bill_data.get('taxAmount') is not None else None,
            'discountpercentage': float(raw_bill_data.get('discountPercentage')) if raw_bill_data.get('discountPercentage') is not None else None,
            'discountamount': float(raw_bill_data.get('discountAmount')) if raw_bill_data.get('discountAmount') is not None else None,
            'total': float(raw_bill_data.get('total')) if raw_bill_data.get('total') is not None else None,
            'paymentmethod': raw_bill_data.get('paymentMethod'),
            'timestamp': raw_bill_data.get('timestamp') or datetime.now().isoformat(),
            'notes': raw_bill_data.get('notes'),
            'gstin': raw_bill_data.get('gstin'),
            'companyname': raw_bill_data.get('companyName'),
            'companyaddress': raw_bill_data.get('companyAddress'),
            'companyphone': raw_bill_data.get('companyPhone'),
            'companyemail': raw_bill_data.get('companyEmail'),
            'billformat': raw_bill_data.get('billFormat', '').lower(), # Ensure lowercase
            'createdby': created_by,
            # 'items' field is for local JSON storage only, not for Supabase 'bills' table
        }
        
        # Remove any None values from bill_data to avoid Supabase errors on non-nullable columns
        bill_data = {k: v for k, v in bill_data.items() if v is not None}

        # CRITICAL: Update stock for each product BEFORE saving bill
        stock_updates = []
        for item in items:
            product_id = item.get('productId')
            quantity_sold = item.get('quantity', 0)
            
            if product_id and quantity_sold > 0:
                supabase_updated = update_product_stock_supabase(product_id, quantity_sold)
                local_updated = update_product_stock_local(product_id, quantity_sold)
                
                stock_updates.append({
                    'productId': product_id,
                    'quantity': quantity_sold,
                    'supabase_updated': supabase_updated,
                    'local_updated': local_updated
                })
                
                if not supabase_updated:
                    app.logger.error(f"Failed to update Supabase stock for product {product_id}")
                if not local_updated:
                    app.logger.error(f"Failed to update local stock for product {product_id}")

        print(f"DEBUG: Final bill_data before sync_to_supabase_immediately: {bill_data}")
        bill_sync_success = sync_to_supabase_immediately('bills', bill_data, 'INSERT')
        
        if not bill_sync_success:
            app.logger.error(f"Failed to save bill {bill_id} to database.")
            return jsonify({"error": "Failed to save bill to database"}), 500
        
        items_synced = 0
        for idx, item in enumerate(items):
            item_id = int(datetime.now().timestamp() * 1000000) + idx
            
            bill_item = {
                'id': item_id,
                'billid': bill_data['id'], # Ensure 'billid' matches the schema
                'productid': item.get('productId'), # Ensure 'productid' matches the schema
                'productname': item.get('productName'), # Ensure 'productname' matches the schema
                'quantity': item.get('quantity'),
                'price': float(item.get('price')) if item.get('price') is not None else None,
                'total': float(item.get('total')) if item.get('total') is not None else None,
                'tax': float(item.get('tax', 0.00)) if item.get('tax') is not None else 0.00,
                'gstrate': float(item.get('gstRate', 0.00)) if item.get('gstRate') is not None else 0.00, # Ensure 'gstrate' matches the schema
                'barcodes': item.get('barcodes', '')
            }
            # Remove any None values from bill_item to avoid Supabase errors on non-nullable columns
            bill_item = {k: v for k, v in bill_item.items() if v is not None}

            if save_bill_item(bill_item):
                items_synced += 1
            else:
                app.logger.error(f"Failed to sync BillItem {item_id} for bill {bill_data['id']}")
        
        # Also save to local JSON as backup
        bills = get_bills_data()
        bill_data_for_json = bill_data.copy()
        bill_data_for_json['items'] = items  # Re-add original items for JSON storage
        bills.append(bill_data_for_json)
        save_bills_data(bills)
        
        # Create notification (with error handling for Unicode and INT overflow)
        try:
            notification_msg = f"New bill created: {bill_data['id']} by {created_by}, Total: Rs.{bill_data.get('total', 0)}"
            create_notification('bill_created', notification_msg, bill_data['id'])
        except Exception as notif_error:
            app.logger.error(f"Failed to create notification: {notif_error}")
        
        return jsonify({
            "message": "Bill saved successfully",
            "billId": bill_data['id'],
            "supabase_synced": bill_sync_success,
            "items_synced": items_synced,
            "customer_created": True, # Customer is always created/updated by get_or_create_customer
            "stock_updates": stock_updates
        }), 200
    
    except Exception as e:
        app.logger.error(f"Error saving bill: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500


@billing_bp.route('/bills', methods=['GET'])
@session_required
def get_bills():
    """Get all bills"""
    try:
        bills = get_bills_data()
        return jsonify(bills), 200
    except Exception as e:
        app.logger.error(f"Error getting bills: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500


@billing_bp.route('/bills/<bill_id>', methods=['GET'])
@session_required
def get_bill_by_id(bill_id):
    """Get a specific bill by ID"""
    try:
        bills = get_bills_data()
        bill = next((b for b in bills if b.get('id') == bill_id), None)
        
        if bill:
            return jsonify(bill), 200
        else:
            return jsonify({"error": "Bill not found"}), 404
    except Exception as e:
        app.logger.error(f"Error getting bill: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500
