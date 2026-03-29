from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from postgrest.exceptions import APIError
from utils.connection_pool import get_supabase_client
from helpers.utils import read_json_file
from config.config import PRODUCTS_FILE, STOREINVENTORY_FILE, USER_STORES_FILE, HSN_CODES_FILE
import time

product_bp = Blueprint('product', __name__)
_PRODUCTS_CLOUD_FAIL_UNTIL = {}
_PRODUCTS_FALLBACK_CACHE = {}
_PRODUCTS_FAIL_COOLDOWN_SECONDS = 5
_PRODUCTS_FALLBACK_CACHE_TTL_SECONDS = 8


def _extract_store_id_from_user_store_row(row: dict):
    if not isinstance(row, dict):
        return None
    return row.get("storeId") or row.get("storeid")


def _get_user_store_rows(supabase, user_id: str):
    """Fetch user-store mappings across schema variants."""
    rows = []
    seen = set()
    for user_col in ("userId", "userid"):
        try:
            response = supabase.table("userstores").select("*").eq(user_col, user_id).execute()
        except APIError:
            continue

        for row in response.data or []:
            key = str(row.get("id") or f"{row.get('userId') or row.get('userid')}::{row.get('storeId') or row.get('storeid')}")
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
    return rows


def _get_store_inventory_rows(supabase, store_id: str):
    """Fetch store inventory rows across storeid/storeId schema variants."""
    rows = []
    seen = set()
    for store_col in ("storeid", "storeId"):
        try:
            response = supabase.table("storeinventory").select("*").eq(store_col, store_id).execute()
        except APIError:
            continue

        for row in response.data or []:
            key = str(row.get("id") or f"{row.get('productid') or row.get('productId')}::{row.get('assignedat') or row.get('updatedat') or ''}")
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
    return rows


def _extract_hsn_code(product_info: dict):
    hsn_ref = product_info.get('hsn_codes')
    if isinstance(hsn_ref, list):
        hsn_ref = hsn_ref[0] if hsn_ref else None
    if isinstance(hsn_ref, dict):
        return hsn_ref.get('hsn_code')
    return None


def _extract_hsn_tax(product_info: dict):
    hsn_ref = product_info.get('hsn_codes')
    if isinstance(hsn_ref, list):
        hsn_ref = hsn_ref[0] if hsn_ref else None
    if isinstance(hsn_ref, dict):
        return hsn_ref.get('tax', 0) or 0
    return 0


def _local_get_store_id_for_user(user_id: str):
    user_stores = read_json_file(USER_STORES_FILE, [])
    match = next(
        (
            row
            for row in user_stores
            if str(row.get("userId") or row.get("userid")) == str(user_id)
        ),
        None,
    )
    if not match:
        return None
    return match.get("storeId") or match.get("storeid")


def _fallback_local_store_id_from_inventory():
    inventory_items = read_json_file(STOREINVENTORY_FILE, [])
    store_ids = {
        str(row.get("storeid") or row.get("storeId"))
        for row in inventory_items
        if row.get("storeid") or row.get("storeId")
    }
    return next(iter(store_ids)) if len(store_ids) == 1 else None


def _build_local_products_response(user_id: str, search: str, limit: int):
    """Build products list from local JSON snapshots for resilient fallback."""
    store_id = _local_get_store_id_for_user(user_id) or _fallback_local_store_id_from_inventory()
    if not store_id:
        return []

    inventory_items = [
        row
        for row in read_json_file(STOREINVENTORY_FILE, [])
        if str(row.get("storeid") or row.get("storeId")) == str(store_id)
    ]
    if not inventory_items:
        return []

    product_ids = {
        str(row.get("productid") or row.get("productId"))
        for row in inventory_items
        if row.get("productid") or row.get("productId")
    }
    if not product_ids:
        return []

    products = read_json_file(PRODUCTS_FILE, [])
    products_by_id = {str(p.get("id")): p for p in products if p.get("id")}
    hsn_codes = read_json_file(HSN_CODES_FILE, [])
    hsn_tax_by_id = {str(h.get("id")): h.get("tax", 0) or 0 for h in hsn_codes if h.get("id") is not None}

    term = search.lower() if search else ""
    final_products = []
    for inv_item in inventory_items:
        product_id = str(inv_item.get("productid") or inv_item.get("productId") or "")
        if not product_id or product_id not in product_ids:
            continue

        product_info = products_by_id.get(product_id)
        if not product_info:
            continue

        barcode = product_info.get("barcode", "")
        name = product_info.get("name", "Unknown Product")
        if term and term not in str(name).lower() and term not in str(barcode).lower():
            continue

        hsn_code_id = product_info.get("hsn_code_id")
        tax = product_info.get("tax", 0) or hsn_tax_by_id.get(str(hsn_code_id), 0) or 0

        final_products.append(
            {
                "id": product_id,
                "name": name,
                "barcode": barcode,
                "barcodes": barcode,
                "selling_price": product_info.get("selling_price", 0),
                "price": product_info.get("price", 0),
                "tax": tax,
                "hsn_code_id": hsn_code_id,
                "hsn_code": product_info.get("hsn_code", ""),
                "stock": inv_item.get("quantity", 0),
                "quantity": inv_item.get("quantity", 0),
                "store_quantity": inv_item.get("quantity", 0),
                "minstocklevel": inv_item.get("minstocklevel", 0),
                "maxstocklevel": inv_item.get("maxstocklevel"),
                "assignedat": inv_item.get("assignedat"),
                "updatedat": inv_item.get("updatedat"),
                "storeid": inv_item.get("storeid") or inv_item.get("storeId"),
                "inventory_id": inv_item.get("id"),
            }
        )

    final_products.sort(key=lambda row: str(row.get("name", "")).lower())
    return final_products[:limit]


def _chunk_list(values, size):
    chunk_size = max(1, int(size))
    for idx in range(0, len(values), chunk_size):
        yield values[idx: idx + chunk_size]


def _products_cache_key(user_id: str, search: str, limit: int):
    return f"{user_id}:{search}:{limit}"


def _build_products_response(items, fallback_used: bool, data_source: str, cached: bool = False):
    response = jsonify(items)
    response.headers["X-Fallback-Used"] = "1" if fallback_used else "0"
    response.headers["X-Data-Source"] = data_source
    response.headers["X-Products-Cached"] = "1" if cached else "0"
    return response


@product_bp.route('/products', methods=['GET'])
@require_auth
def get_products():
    """Get products from current user's store inventory"""
    current_user_id = get_jwt_identity()
    search = request.args.get('search', '').strip()
    limit = request.args.get('limit', 100, type=int)

    cache_key = _products_cache_key(str(current_user_id), search, limit)
    now_ts = time.time()
    fail_until = float(_PRODUCTS_CLOUD_FAIL_UNTIL.get(cache_key, 0))
    if now_ts < fail_until and not search:
        cached = _PRODUCTS_FALLBACK_CACHE.get(cache_key)
        if cached and now_ts - float(cached.get("ts", 0)) <= _PRODUCTS_FALLBACK_CACHE_TTL_SECONDS:
            return _build_products_response(cached.get("items", []), fallback_used=True, data_source="local_snapshot", cached=True), 200

        local_items = _build_local_products_response(current_user_id, search, limit)
        _PRODUCTS_FALLBACK_CACHE[cache_key] = {"ts": now_ts, "items": local_items}
        return _build_products_response(local_items, fallback_used=True, data_source="local_snapshot", cached=False), 200

    try:
        app.logger.info(f"User {current_user_id} fetching store inventory products")

        supabase = get_supabase_client()
        if getattr(supabase, "is_offline_fallback", False):
            local_items = _build_local_products_response(current_user_id, search, limit)
            _PRODUCTS_FALLBACK_CACHE[cache_key] = {"ts": time.time(), "items": local_items}
            return _build_products_response(local_items, fallback_used=True, data_source="local_snapshot", cached=False), 200

        # Step 1: Get user's store ID
        user_store_rows = _get_user_store_rows(supabase, str(current_user_id))
        if not user_store_rows:
            app.logger.warning(f"No store assigned to user {current_user_id}; trying local products fallback")
            local_items = _build_local_products_response(current_user_id, search, limit)
            return _build_products_response(local_items, fallback_used=True, data_source="local_snapshot", cached=False), 200

        store_id = _extract_store_id_from_user_store_row(user_store_rows[0])
        if not store_id:
            app.logger.warning(f"Store mapping row found without store ID for user {current_user_id}; trying local products fallback")
            local_items = _build_local_products_response(current_user_id, search, limit)
            return _build_products_response(local_items, fallback_used=True, data_source="local_snapshot", cached=False), 200
        app.logger.info(f"Fetching inventory for store: {store_id}")

        # Step 2: Get storeinventory data
        inventory_items = _get_store_inventory_rows(supabase, str(store_id))
        if not inventory_items:
            app.logger.info(f"No inventory found for store {store_id}")
            return jsonify([]), 200

        app.logger.info(f"Found {len(inventory_items)} inventory items")

        # Step 3: Get product IDs
        product_ids = [
            str(item.get("productid") or item.get("productId"))
            for item in inventory_items
            if item.get("productid") or item.get("productId")
        ]
        if not product_ids:
            app.logger.warning("No product IDs found in inventory")
            return jsonify([]), 200

        # Step 4: Get product details WITH HSN tax (products.tax removed)
        # Fetch in chunks + retry to reduce intermittent 502s from large/complex edge queries.
        chunked_products = []
        seen_ids = set()
        max_retries = 2
        for ids_chunk in _chunk_list(product_ids, 40):
            query = supabase.table('products') \
                .select('id, name, barcode, selling_price, price, hsn_code_id, hsn_codes(hsn_code, tax)') \
                .in_('id', ids_chunk)
            if search:
                query = query.or_(f"name.ilike.%{search}%,barcode.ilike.%{search}%")

            chunk_response = None
            for attempt in range(max_retries + 1):
                try:
                    chunk_response = query.limit(limit).order('name').execute()
                    break
                except APIError as chunk_error:
                    is_last_attempt = attempt >= max_retries
                    if is_last_attempt:
                        app.logger.warning(
                            f"Products cloud query failed for store {store_id}; serving local snapshot fallback. Error: {chunk_error}"
                        )
                        _PRODUCTS_CLOUD_FAIL_UNTIL[cache_key] = time.time() + _PRODUCTS_FAIL_COOLDOWN_SECONDS
                        local_items = _build_local_products_response(current_user_id, search, limit)
                        _PRODUCTS_FALLBACK_CACHE[cache_key] = {"ts": time.time(), "items": local_items}
                        return _build_products_response(local_items, fallback_used=True, data_source="local_snapshot", cached=False), 200
                    time.sleep(0.15 * (attempt + 1))

            if not chunk_response or not chunk_response.data:
                continue

            for product in chunk_response.data:
                pid = product.get("id")
                if not pid or pid in seen_ids:
                    continue
                seen_ids.add(pid)
                chunked_products.append(product)

        if not chunked_products:
            app.logger.info("No products found matching criteria")
            return _build_products_response([], fallback_used=False, data_source="cloud"), 200

        products = chunked_products
        product_info_map = {p['id']: p for p in products}

        # Step 5: Build final product list
        final_products = []
        for inv_item in inventory_items:
            product_id = inv_item.get('productid') or inv_item.get('productId')
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
                'tax': _extract_hsn_tax(product_info),
                'hsn_code_id': product_info.get('hsn_code_id'),
                'hsn_code': _extract_hsn_code(product_info),
                'stock': inv_item.get('quantity', 0),
                'quantity': inv_item.get('quantity', 0),
                'store_quantity': inv_item.get('quantity', 0),
                'minstocklevel': inv_item.get('minstocklevel', 0),
                'maxstocklevel': inv_item.get('maxstocklevel', None),
                'assignedat': inv_item.get('assignedat'),
                'updatedat': inv_item.get('updatedat'),
                'storeid': inv_item.get('storeid') or inv_item.get('storeId'),
                'inventory_id': inv_item.get('id'),
            }
            final_products.append(product)

        app.logger.info(f"Returning {len(final_products)} products from store inventory")
        _PRODUCTS_CLOUD_FAIL_UNTIL.pop(cache_key, None)
        return _build_products_response(final_products, fallback_used=False, data_source="cloud"), 200

    except Exception as e:
        app.logger.error(f"Error fetching store inventory products: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        _PRODUCTS_CLOUD_FAIL_UNTIL[cache_key] = time.time() + _PRODUCTS_FAIL_COOLDOWN_SECONDS
        local_items = _build_local_products_response(current_user_id, search, limit)
        _PRODUCTS_FALLBACK_CACHE[cache_key] = {"ts": time.time(), "items": local_items}
        return _build_products_response(local_items, fallback_used=True, data_source="local_snapshot", cached=False), 200


@product_bp.route('/products/<product_id>', methods=['GET'])
@require_auth
def get_product(product_id):
    """Get a specific product from store inventory"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching product {product_id}")

        supabase = get_supabase_client()

        # Get user's store ID
        user_store_rows = _get_user_store_rows(supabase, str(current_user_id))
        if not user_store_rows:
            return jsonify({"message": "No store assigned to this user"}), 404

        store_id = _extract_store_id_from_user_store_row(user_store_rows[0])
        if not store_id:
            return jsonify({"message": "No store assigned to this user"}), 404

        # Get from storeinventory
        inventory_items = _get_store_inventory_rows(supabase, str(store_id))
        inventory_matches = [
            row for row in inventory_items
            if str(row.get("productid") or row.get("productId")) == str(product_id)
        ]

        if not inventory_matches:
            return jsonify({"message": "Product not found in store inventory"}), 404

        inv_item = inventory_matches[0]

        # Get product details including HSN tax
        product_response = supabase.table('products') \
            .select('id, name, barcode, selling_price, price, hsn_code_id, hsn_codes(hsn_code, tax)') \
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
            'tax': _extract_hsn_tax(product_info),
            'hsn_code_id': product_info.get('hsn_code_id'),
            'hsn_code': _extract_hsn_code(product_info),
            'stock': inv_item.get('quantity', 0),
            'quantity': inv_item.get('quantity', 0),
            'minstocklevel': inv_item.get('minstocklevel', 0),
            'maxstocklevel': inv_item.get('maxstocklevel'),
            'storeid': inv_item.get('storeid') or inv_item.get('storeId'),
            'inventory_id': inv_item.get('id'),
        }

        return jsonify(product), 200

    except Exception as e:
        app.logger.error(f"Error fetching product {product_id}: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        cached_products = read_json_file(PRODUCTS_FILE, [])
        product = next((p for p in cached_products if str(p.get("id")) == str(product_id)), None)
        if not product:
            return jsonify({"message": "Product not found"}), 404
        return jsonify(product), 200
