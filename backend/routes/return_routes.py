import uuid
from datetime import datetime
from flask import Blueprint, jsonify, request, g, current_app as app
from auth.auth import session_required # Changed from token_required
from data_access.data_access import get_bills_data, get_returns_data, save_returns_data
from notifications.notifications import create_notification
from data_access.mysql_data_access import sync_to_mysql_immediately

return_bp = Blueprint('return_bp', __name__)

@return_bp.route('/returns/search', methods=['POST'])
@session_required
def search_bills_for_returns():
    """Search bills for returns"""
    try:
        data = request.json
        if not data:
            return jsonify({"error": "Request data is required"}), 400

        query = data.get('query', '').strip().lower()
        search_type = data.get('searchType', 'customer')

        if not query:
            return jsonify({"error": "Search query is required"}), 400

        app.logger.debug(f"Search query: '{query}', Search type: '{search_type}'") # Added debug log

        bills = get_bills_data()
        matching_bills = []

        for bill in bills:
            match_found = False
            app.logger.debug(f"Processing bill ID: {bill.get('id', '')}") # Added debug log

            if search_type == 'customer':
                if query in bill.get('customerName', '').lower():
                    match_found = True
            elif search_type == 'phone':
                phone = bill.get('customerPhone', '').replace(' ', '').replace('-', '')
                if query.replace(' ', '').replace('-', '') in phone:
                    match_found = True
            elif search_type == 'invoice':
                bill_id_lower = bill.get('id', '').lower()
                # Check for exact match of the full ID (e.g., "inv-123456")
                if query == bill_id_lower:
                    match_found = True
                # Check for match of the numeric part (e.g., "123456")
                elif bill_id_lower.startswith('inv-') and query == bill_id_lower[4:]:
                    match_found = True
                # Fallback to partial match if neither of the above
                elif query in bill_id_lower:
                    match_found = True

            if match_found:
                matching_bills.append(bill)

        matching_bills.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
        app.logger.debug(f"Final matching bills: {matching_bills}") # Added debug log

        return jsonify(matching_bills), 200

    except Exception as e:
        app.logger.error(f"Error searching bills: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@return_bp.route('/returns/submit', methods=['POST'])
@session_required
def submit_return_request():
    """Submit a return request"""
    try:
        data = request.json
        if not data:
            return jsonify({"error": "Request data is required"}), 400

        selected_items = data.get('selectedItems', [])
        return_reason = data.get('returnReason', '').strip()
        refund_method = data.get('refundMethod', 'cash')
        search_results = data.get('searchResults', [])
        created_by = g.current_user['id']

        if not selected_items or not return_reason:
            return jsonify({"error": "Selected items and return reason are required"}), 400

        existing_returns = get_returns_data()
        new_returns = []
        total_return_amount = 0

        # Handle selectedItems as objects with 'id' and 'quantity'
        for item_obj in selected_items:
            try:
                # Extract id and quantity from the object
                item_id = item_obj.get('id', '') if isinstance(item_obj, dict) else item_obj
                return_quantity = item_obj.get('quantity', 1) if isinstance(item_obj, dict) else 1

                # Parse the item ID to get bill_id and item_index
                parts = item_id.rsplit('-', 1)
                if len(parts) != 2:
                    app.logger.error(f"Invalid item ID format: {item_id}")
                    continue
                    
                bill_id = parts[0]
                item_index = int(parts[1])

                # Find the bill and item
                bill = next((b for b in search_results if b['id'] == bill_id), None)
                if not bill:
                    app.logger.error(f"Bill not found: {bill_id}")
                    continue
                
                if item_index >= len(bill.get('items', [])):
                    app.logger.error(f"Item index {item_index} out of range for bill {bill_id}")
                    continue

                item = bill['items'][item_index]
                
                # Log the item structure for debugging
                app.logger.debug(f"Item structure: {item}")
                
                # Flexible key access - try different possible key names
                product_name = (
                    item.get('productName') or 
                    item.get('product_name') or 
                    item.get('name') or 
                    item.get('Name') or 
                    'Unknown Product'
                )
                
                product_id = (
                    item.get('productId') or 
                    item.get('product_id') or 
                    item.get('id') or 
                    ''
                )
                
                unit_price = (
                    item.get('price') or 
                    item.get('unit_price') or 
                    item.get('unitPrice') or 
                    0
                )
                
                # Validate return quantity
                original_quantity = item.get('quantity', 1)
                if return_quantity > original_quantity:
                    app.logger.error(f"Return quantity {return_quantity} exceeds original {original_quantity}")
                    return_quantity = original_quantity

                # Calculate return amount based on selected quantity
                return_amount = float(unit_price) * return_quantity

                return_record = {
                    'return_id': str(uuid.uuid4()),
                    'product_name': product_name,
                    'product_id': product_id,
                    'customer_name': bill.get('customerName', ''),
                    'customer_phone_number': bill.get('customerPhone', ''),
                    'message': return_reason,
                    'refund_method': refund_method,
                    'bill_id': bill_id,
                    'item_index': item_index,
                    'original_quantity': original_quantity,
                    'return_quantity': return_quantity,
                    'unit_price': float(unit_price),
                    'return_amount': return_amount,
                    'status': 'pending',
                    'created_by': created_by,
                    'created_at': datetime.now().isoformat(),
                    'updated_at': datetime.now().isoformat()
                }

                new_returns.append(return_record)
                total_return_amount += return_amount

                # Sync to MySQL
                sync_to_mysql_immediately('Returns', return_record, 'INSERT')

            except Exception as e:
                app.logger.error(f"Error processing return item {item_obj}: {e}", exc_info=True)
                continue

        if not new_returns:
            return jsonify({"error": "No valid items found for return"}), 400

        existing_returns.extend(new_returns)
        save_returns_data(existing_returns)

        # Create notification
        notification_msg = f"New return request: {len(new_returns)} items, ₹{total_return_amount:.2f}"
        create_notification('return_request', notification_msg, new_returns[0]['return_id'])

        return jsonify({
            "message": "Return request submitted successfully",
            "returnId": new_returns[0]['return_id'],
            "itemCount": len(new_returns),
            "totalAmount": total_return_amount
        }), 200

    except Exception as e:
        app.logger.error(f"Error submitting return: {e}", exc_info=True)
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@return_bp.route('/returns/list', methods=['GET'])
@session_required
def get_returns_list():
    """Get all return requests"""
    try:
        returns = get_returns_data()
        # Sort by created_at descending (newest first)
        returns.sort(key=lambda x: x.get('created_at', ''), reverse=True)
        return jsonify(returns), 200
    except Exception as e:
        app.logger.error(f"Error fetching returns: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@return_bp.route('/returns/pending/count', methods=['GET'])
@session_required
def get_pending_returns_count():
    """Get count of pending return requests"""
    try:
        returns = get_returns_data()
        pending_count = sum(1 for r in returns if r.get('status') == 'pending')
        return jsonify({"count": pending_count}), 200
    except Exception as e:
        app.logger.error(f"Error fetching pending returns count: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@return_bp.route('/returns/<return_id>/approve', methods=['POST'])
@session_required
def approve_return(return_id):
    """Approve a return request"""
    try:
        returns = get_returns_data()
        return_item = next((r for r in returns if r['return_id'] == return_id), None)
        
        if not return_item:
            return jsonify({"error": "Return request not found"}), 404
        
        if return_item['status'] != 'pending':
            return jsonify({"error": "Return request is not pending"}), 400
        
        # Update status to approved
        return_item['status'] = 'approved'
        return_item['updated_at'] = datetime.now().isoformat()
        return_item['approved_by'] = g.current_user['id']
        return_item['approved_at'] = datetime.now().isoformat()
        
        # Save updated returns
        save_returns_data(returns)
        
        # Sync to MySQL
        sync_to_mysql_immediately('Returns', return_item, 'UPDATE')
        
        # Create notification
        notification_msg = f"Return request approved: {return_item['product_name']} - ₹{return_item['return_amount']:.2f}"
        create_notification('return_approved', notification_msg, return_id)
        
        return jsonify({
            "message": "Return request approved successfully",
            "return": return_item
        }), 200
        
    except Exception as e:
        app.logger.error(f"Error approving return: {e}", exc_info=True)
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@return_bp.route('/returns/<return_id>/deny', methods=['POST'])
@session_required
def deny_return(return_id):
    """Deny a return request"""
    try:
        data = request.json or {}
        denial_reason = data.get('reason', 'No reason provided')
        
        returns = get_returns_data()
        return_item = next((r for r in returns if r['return_id'] == return_id), None)
        
        if not return_item:
            return jsonify({"error": "Return request not found"}), 404
        
        if return_item['status'] != 'pending':
            return jsonify({"error": "Return request is not pending"}), 400
        
        # Update status to denied
        return_item['status'] = 'denied'
        return_item['updated_at'] = datetime.now().isoformat()
        return_item['denied_by'] = g.current_user['id']
        return_item['denied_at'] = datetime.now().isoformat()
        return_item['denial_reason'] = denial_reason
        
        # Save updated returns
        save_returns_data(returns)
        
        # Sync to MySQL
        sync_to_mysql_immediately('Returns', return_item, 'UPDATE')
        
        # Create notification
        notification_msg = f"Return request denied: {return_item['product_name']} - Reason: {denial_reason}"
        create_notification('return_denied', notification_msg, return_id)
        
        return jsonify({
            "message": "Return request denied successfully",
            "return": return_item
        }), 200
        
    except Exception as e:
        app.logger.error(f"Error denying return: {e}", exc_info=True)
        return jsonify({"error": "Internal server error", "details": str(e)}), 500
