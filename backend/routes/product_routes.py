from flask import Blueprint, jsonify, request, current_app as app
from datetime import datetime

from auth.auth import session_required # Changed from token_required
from data_access.data_access import get_products_data, save_products_data
from utils.connection_pool import get_connection

product_bp = Blueprint('product_bp', __name__)

@product_bp.route('/products', methods=['GET'])
@session_required
def get_products():
    """Get all products"""
    try:
        products = get_products_data()
        return jsonify(products), 200
    except Exception as e:
        app.logger.error(f"Error getting products: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@product_bp.route('/products/<product_id>', methods=['PUT'])
@session_required
def update_product_stock(product_id):
    """Update product stock after billing"""
    try:
        data = request.json
        if not data or 'quantity' not in data:
            return jsonify({"error": "Quantity is required"}), 400
        
        quantity_sold = int(data['quantity'])
        
        products = get_products_data()
        product_found = False
        for product in products:
            if str(product['id']) == product_id:
                product['stock'] -= quantity_sold
                product['updatedAt'] = datetime.now().isoformat()
                product_found = True
                break
        
        if not product_found:
            return jsonify({"error": "Product not found"}), 404

        save_products_data(products)
        
        return jsonify({"message": "Stock updated successfully"}), 200
            
    except Exception as e:
        app.logger.error(f"Error updating product stock: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500
