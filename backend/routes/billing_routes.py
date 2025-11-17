import uuid
from datetime import datetime
from flask import Blueprint, jsonify, request, g, current_app as app

from auth.auth import session_required # Changed from token_required
from data_access.data_access import get_bills_data, save_bills_data, get_products_data, save_products_data
from data_access.mysql_data_access import (
    sync_to_mysql_immediately, check_user_exists_mysql, check_customer_exists_mysql
)
from notifications.notifications import create_notification
from utils.connection_pool import get_connection

billing_bp = Blueprint('billing_bp', __name__)


def get_or_create_customer(customer_name: str, customer_phone: str, customer_email: str = '', customer_address: str = '') -> str:
    """
    Get existing customer by phone or create new one
    Returns customer_id
    """
    connection = None
    try:
        connection = get_connection()
        if not connection:
            app.logger.error("No database connection for customer lookup")
            return None
        
        cursor = connection.cursor(dictionary=True)
        
        try:
            # Check if customer exists by phone
            if customer_phone:
                cursor.execute(
                    "SELECT id FROM Customers WHERE phone = %s",
                    (customer_phone,)
                )
                existing_customer = cursor.fetchone()
                
                if existing_customer:
                    # Update customer info if provided
                    if customer_name:
                        cursor.execute("""
                            UPDATE Customers 
                            SET name = %s, email = %s, address = %s, updatedAt = %s
                            WHERE id = %s
                        """, (customer_name, customer_email, customer_address, datetime.now(), existing_customer['id']))
                        connection.commit()
                    
                    return existing_customer['id']
            
            # Create new customer
            customer_id = f"CUST-{uuid.uuid4().hex[:12]}"
            now = datetime.now()
            
            cursor.execute("""
                INSERT INTO Customers (id, name, phone, email, address, createdAt, updatedAt)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
            """, (
                customer_id,
                customer_name or 'Walk-in Customer',
                customer_phone or '',
                customer_email or '',
                customer_address or '',
                now,
                now
            ))
            connection.commit()
            
            app.logger.info(f"Created new customer: {customer_id}")
            return customer_id
            
        finally:
            cursor.close()
            
    except Exception as e:
        app.logger.error(f"Error in get_or_create_customer: {e}")
        if connection:
            connection.rollback()
        return None
    finally:
        if connection:
            connection.close()


def update_product_stock_mysql(product_id: str, quantity_sold: int) -> bool:
    """
    Atomically update product stock in MySQL database
    Uses SELECT FOR UPDATE to prevent race conditions
    """
    connection = None
    try:
        connection = get_connection()
        if not connection:
            app.logger.error("No database connection for stock update")
            return False
        
        cursor = connection.cursor(dictionary=True)
        
        try:
            connection.start_transaction()
            
            # Lock the row and get current stock
            cursor.execute(
                "SELECT stock FROM Products WHERE id = %s FOR UPDATE",
                (product_id,)
            )
            product = cursor.fetchone()
            
            if not product:
                app.logger.error(f"Product {product_id} not found in MySQL")
                connection.rollback()
                return False
            
            current_stock = product['stock']
            new_stock = current_stock - quantity_sold
            
            if new_stock < 0:
                app.logger.warning(
                    f"Stock going negative for product {product_id}. "
                    f"Current: {current_stock}, Sold: {quantity_sold}, New: {new_stock}"
                )
            
            # Update stock atomically
            cursor.execute(
                "UPDATE Products SET stock = %s, updatedAt = %s WHERE id = %s",
                (new_stock, datetime.now().isoformat(), product_id)
            )
            
            connection.commit()
            app.logger.info(f"MySQL stock updated for {product_id}: {current_stock} -> {new_stock}")
            return True
            
        except Exception as e:
            connection.rollback()
            app.logger.error(f"Error updating MySQL stock: {e}")
            return False
            
        finally:
            if connection.is_connected():
                cursor.close()
    
    except Exception as e:
        app.logger.error(f"Error getting connection for stock update: {e}")
        return False
    
    finally:
        if connection and connection.is_connected():
            connection.close()


def update_product_stock_local(product_id: str, quantity_sold: int) -> bool:
    """
    Update product stock in local JSON file
    """
    try:
        products = get_products_data()
        
        product_found = False
        for product in products:
            if str(product.get('id')) == str(product_id):
                current_stock = product.get('stock', 0)
                new_stock = current_stock - quantity_sold
                product['stock'] = new_stock
                product['updatedAt'] = datetime.now().isoformat()
                product_found = True
                app.logger.info(f"Local JSON stock updated for {product_id}: {current_stock} -> {new_stock}")
                break
        
        if not product_found:
            app.logger.warning(f"Product {product_id} not found in local JSON")
            return False
        
        # Save updated products to JSON
        save_products_data(products)
        return True
        
    except Exception as e:
        app.logger.error(f"Error updating local product stock: {e}")
        return False


@billing_bp.route('/bills', methods=['POST'])
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
        
        bill_data = request.json
        if not bill_data:
            return jsonify({"error": "No bill data provided"}), 400
        
        # Validate required fields
        if not bill_data.get('id'):
            bill_data['id'] = str(uuid.uuid4())
        
        # Validate user exists
        created_by = bill_data.get('createdBy') or g.current_user['id']
        bill_data['createdBy'] = created_by
        
        if not check_user_exists_mysql(created_by):
            return jsonify({"error": f"User {created_by} does not exist"}), 400
        
        # Set customerId from the helper function
        bill_data['customerId'] = customer_id
        
        # Add timestamps
        bill_data['timestamp'] = bill_data.get('timestamp') or datetime.now().isoformat()
        
        # Extract items for separate syncing
        items = bill_data.pop('items', [])
        
        # CRITICAL: Update stock for each product BEFORE saving bill
        stock_updates = []
        for item in items:
            product_id = item.get('productId')
            quantity_sold = item.get('quantity', 0)
            
            if product_id and quantity_sold > 0:
                # Update stock in both MySQL and local JSON
                mysql_updated = update_product_stock_mysql(product_id, quantity_sold)
                local_updated = update_product_stock_local(product_id, quantity_sold)
                
                stock_updates.append({
                    'productId': product_id,
                    'quantity': quantity_sold,
                    'mysql_updated': mysql_updated,
                    'local_updated': local_updated
                })
                
                if not mysql_updated:
                    app.logger.error(f"Failed to update MySQL stock for product {product_id}")
                if not local_updated:
                    app.logger.error(f"Failed to update local stock for product {product_id}")
        
        # Save bill to MySQL (after customer and stock updates)
        bill_sync_success = sync_to_mysql_immediately('Bills', bill_data, 'INSERT')
        
        if not bill_sync_success:
            return jsonify({"error": "Failed to save bill to database"}), 500
        
        # Save bill items to MySQL (after bill exists)
        items_synced = 0
        for idx, item in enumerate(items):
            # FIX: Use bigint-safe ID generation
            item_id = int(datetime.now().timestamp() * 1000000) + idx
            
            bill_item = {
                'id': item_id,
                'billId': bill_data['id'],
                'productId': item.get('productId'),
                'productName': item.get('productName'),
                'quantity': item.get('quantity'),
                'price': item.get('price'),
                'total': item.get('total'),
                'tax': item.get('tax', 0.00),
                'gstRate': item.get('gstRate', 0.00),
                'barcodes': item.get('barcodes', '')
            }
            
            if sync_to_mysql_immediately('BillItems', bill_item, 'INSERT'):
                items_synced += 1
            else:
                app.logger.error(f"Failed to sync BillItem {item_id} for bill {bill_data['id']}")
        
        # Also save to local JSON as backup
        bills = get_bills_data()
        bill_data['items'] = items  # Re-add items for JSON storage
        bills.append(bill_data)
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
            "mysql_synced": bill_sync_success,
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
