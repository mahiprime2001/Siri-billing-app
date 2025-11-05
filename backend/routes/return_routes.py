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
        
        bills = get_bills_data()
        matching_bills = []
        
        for bill in bills:
            match_found = False
            
            if search_type == 'customer':
                if query in bill.get('customerName', '').lower():
                    match_found = True
            elif search_type == 'phone':
                phone = bill.get('customerPhone', '').replace(' ', '').replace('-', '')
                if query.replace(' ', '').replace('-', '') in phone:
                    match_found = True
            elif search_type == 'invoice':
                if query in bill.get('id', '').lower():
                    match_found = True
            
            if match_found:
                matching_bills.append(bill)
        
        matching_bills.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
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
        
        for item_id in selected_items:
            try:
                bill_id, item_index = item_id.split('-')
                item_index = int(item_index)
                
                bill = next((b for b in search_results if b['id'] == bill_id), None)
                if not bill or item_index >= len(bill['items']):
                    continue
                
                item = bill['items'][item_index]
                return_record = {
                    'return_id': str(uuid.uuid4()),
                    'product_name': item['productName'],
                    'product_id': item.get('productId', ''),
                    'customer_name': bill.get('customerName', ''),
                    'customer_phone_number': bill.get('customerPhone', ''),
                    'message': return_reason,
                    'refund_method': refund_method,
                    'bill_id': bill_id,
                    'item_index': item_index,
                    'return_amount': float(item['total']),
                    'status': 'pending',
                    'created_by': created_by,
                    'created_at': datetime.now().isoformat(),
                    'updated_at': datetime.now().isoformat()
                }
                
                new_returns.append(return_record)
                total_return_amount += float(item['total'])
                
                # Sync to MySQL
                sync_to_mysql_immediately('Returns', return_record, 'INSERT')
            
            except Exception as e:
                app.logger.error(f"Error processing return item {item_id}: {e}")
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
        app.logger.error(f"Error submitting return: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500
