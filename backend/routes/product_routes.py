from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client

product_bp = Blueprint('product', __name__)

def _extract_hsn_code(product_info: dict):
    hsn_ref = product_info.get('hsn_codes')
    if isinstance(hsn_ref, list):
        hsn_ref = hsn_ref[0] if hsn_ref else None
    if isinstance(hsn_ref, dict):
        return hsn_ref.get('hsn_code')
    return None

@product_bp.route('/products', methods=['GET'])
@require_auth
def get_products():
    """Get products from current user's store inventory"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"📦 User {current_user_id} fetching store inventory products")
        
        search = request.args.get('search', '').strip()
        limit = request.args.get('limit', 100, type=int)
        
        supabase = get_supabase_client()
        
        # ✅ Step 1: Get user's store ID
        user_store_response = supabase.table('userstores') \
            .select('storeId') \
            .eq('userId', current_user_id) \
            .execute()
        
        if not user_store_response.data or len(user_store_response.data) == 0:
            app.logger.warning(f"⚠️ No store assigned to user {current_user_id}")
            return jsonify([]), 200
        
        store_id = user_store_response.data[0]['storeId']
        app.logger.info(f"📍 Fetching inventory for store: {store_id}")
        
        # ✅ Step 2: Get storeinventory data
        inventory_query = supabase.table('storeinventory') \
            .select('id, storeid, productid, quantity, minstocklevel, maxstocklevel, assignedat, updatedat') \
            .eq('storeid', store_id)
        
        inventory_response = inventory_query.execute()
        
        if not inventory_response.data:
            app.logger.info(f"⚠️ No inventory found for store {store_id}")
            return jsonify([]), 200
        
        inventory_items = inventory_response.data
        app.logger.info(f"📦 Found {len(inventory_items)} inventory items")
        
        # ✅ Step 3: Get product IDs
        product_ids = [item['productid'] for item in inventory_items if item.get('productid')]
        
        if not product_ids:
            app.logger.warning(f"⚠️ No product IDs found in inventory")
            return jsonify([]), 200
        
        # ✅ Step 4: Get product details INCLUDING tax field
        products_query = supabase.table('products') \
            .select('id, name, barcode, selling_price, price, tax, hsn_code_id, hsn_codes(hsn_code)') \
            .in_('id', product_ids)
        
        if search:
            products_query = products_query.or_(
                f'name.ilike.%{search}%,barcode.ilike.%{search}%'
            )
        
        products_response = products_query.limit(limit).order('name').execute()
        
        if not products_response.data:
            app.logger.info(f"⚠️ No products found matching criteria")
            return jsonify([]), 200
        
        products = products_response.data
        product_info_map = {p['id']: p for p in products}
        
        # ✅ Step 5: Build final product list
        final_products = []
        for inv_item in inventory_items:
            product_id = inv_item.get('productid')
            
            if product_id not in product_info_map:
                continue
            
            product_info = product_info_map[product_id]
            
            product = {
                'id': product_id,
                'name': product_info.get('name', 'Unknown Product'),
                'barcode': product_info.get('barcode', ''),
                'barcodes': product_info.get('barcode', ''),
                'selling_price': product_info.get('selling_price', 0),
                'price': product_info.get('price', 0),
                'tax': product_info.get('tax', 0),  # ✅ ADDED TAX FIELD
                'hsn_code_id': product_info.get('hsn_code_id'),
                'hsn_code': _extract_hsn_code(product_info),
                'stock': inv_item.get('quantity', 0),
                'quantity': inv_item.get('quantity', 0),
                'store_quantity': inv_item.get('quantity', 0),
                'minstocklevel': inv_item.get('minstocklevel', 0),
                'maxstocklevel': inv_item.get('maxstocklevel', None),
                'assignedat': inv_item.get('assignedat'),
                'updatedat': inv_item.get('updatedat'),
                'storeid': inv_item.get('storeid'),
                'inventory_id': inv_item.get('id'),
            }
            
            final_products.append(product)
        
        app.logger.info(f"✅ Returning {len(final_products)} products from store inventory")
        return jsonify(final_products), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching store inventory products: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred"}), 500


@product_bp.route('/products/<product_id>', methods=['GET'])
@require_auth
def get_product(product_id):
    """Get a specific product from store inventory"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching product {product_id}")
        
        supabase = get_supabase_client()
        
        # Get user's store ID
        user_store_response = supabase.table('userstores') \
            .select('storeId') \
            .eq('userId', current_user_id) \
            .execute()
        
        if not user_store_response.data or len(user_store_response.data) == 0:
            return jsonify({"message": "No store assigned to this user"}), 404
        
        store_id = user_store_response.data[0]['storeId']
        
        # Get from storeinventory
        inventory_response = supabase.table('storeinventory') \
            .select('*') \
            .eq('storeid', store_id) \
            .eq('productid', product_id) \
            .execute()
        
        if not inventory_response.data or len(inventory_response.data) == 0:
            return jsonify({"message": "Product not found in store inventory"}), 404
        
        inv_item = inventory_response.data[0]
        
        # Get product details including tax
        product_response = supabase.table('products') \
            .select('id, name, barcode, selling_price, price, tax, hsn_code_id, hsn_codes(hsn_code)') \
            .eq('id', product_id) \
            .execute()
        
        if not product_response.data:
            return jsonify({"message": "Product not found"}), 404
        
        product_info = product_response.data[0]
        
        product = {
            'id': product_id,
            'name': product_info.get('name'),
            'barcode': product_info.get('barcode', ''),
            'barcodes': product_info.get('barcode', ''),
            'selling_price': product_info.get('selling_price', 0),
            'price': product_info.get('price', 0),
            'tax': product_info.get('tax', 0),  # ✅ ADDED TAX FIELD
            'hsn_code_id': product_info.get('hsn_code_id'),
            'hsn_code': _extract_hsn_code(product_info),
            'stock': inv_item.get('quantity', 0),
            'quantity': inv_item.get('quantity', 0),
            'minstocklevel': inv_item.get('minstocklevel', 0),
            'maxstocklevel': inv_item.get('maxstocklevel'),
            'storeid': inv_item.get('storeid'),
            'inventory_id': inv_item.get('id'),
        }
        
        return jsonify(product), 200
        
    except Exception as e:
        app.logger.error(f"Error fetching product {product_id}: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred"}), 500
