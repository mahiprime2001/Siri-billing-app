from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from postgrest.exceptions import APIError
from utils.connection_pool import get_supabase_client
from helpers.utils import read_json_file, write_json_file
from config.config import PRODUCTS_FILE, STOREINVENTORY_FILE, USER_STORES_FILE, HSN_CODES_FILE
from utils.products_cache import (
    get_cloud_products_cache_with_age,
    set_cloud_products_cache,
)
import threading
import time

product_bp = Blueprint('product', __name__)
_PRODUCTS_CLOUD_FAIL_UNTIL = {}
_PRODUCTS_FALLBACK_CACHE = {}
_PRODUCTS_FAIL_COOLDOWN_SECONDS = 5
_PRODUCTS_FALLBACK_CACHE_TTL_SECONDS = 8
_PRODUCTS_CLOUD_CACHE_TTL_SECONDS = 60
_PRODUCTS_CACHE_STALE_AFTER_SECONDS = 30
_STORE_INVENTORY_PAGE_SIZE = 100
_RETRY_ATTEMPTS = 3
_RETRY_BASE_DELAY = 0.2
_PRODUCTS_BG_REFRESH_INFLIGHT = set()
_PRODUCTS_BG_REFRESH_LOCK = threading.Lock()


def _execute_with_retry(operation, max_attempts: int = _RETRY_ATTEMPTS, base_delay: float = _RETRY_BASE_DELAY):
    """Run a Supabase call with exponential backoff. Returns (data, error)."""
    last_err = None
    for attempt in range(max_attempts):
        try:
            return operation(), None
        except APIError as err:
            last_err = err
            code = getattr(err, 'code', '') or ''
            message = (str(err) or '').lower()
            # Don't retry hard errors (auth/permission/schema-mismatch).
            if code in ('PGRST301', 'PGRST302') or 'permission' in message or 'denied' in message:
                break
        except Exception as err:
            last_err = err
        if attempt < max_attempts - 1:
            time.sleep(base_delay * (2 ** attempt))
    return None, last_err


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


_INVENTORY_JOIN_SELECT = (
    "*, products(id, name, barcode, selling_price, price, hsn_code_id, "
    "hsn_codes(hsn_code, tax))"
)


def _get_store_inventory_rows(supabase, store_id: str):
    """Plain inventory fetch (no product join). Kept for callers that don't need the join."""
    rows, _partial = _get_store_inventory_with_products(supabase, store_id, with_products=False)
    return rows


def _get_store_inventory_with_products(supabase, store_id: str, with_products: bool = True):
    """Fetch storeinventory rows (optionally joined with products+hsn_codes) in fixed pages.

    Returns (rows, partial_flag). partial_flag is True when one or more pages failed
    after retry exhaustion — caller must NOT cache the result in that case.
    """
    rows = []
    seen = set()
    partial = False
    select_clause = _INVENTORY_JOIN_SELECT if with_products else "*"

    for store_col in ("storeid", "storeId"):
        offset = 0
        first_page_seen = False
        consecutive_failures = 0
        while True:
            captured_offset = offset
            captured_col = store_col

            def do_query():
                return (
                    supabase.table("storeinventory")
                    .select(select_clause)
                    .eq(captured_col, store_id)
                    .range(captured_offset, captured_offset + _STORE_INVENTORY_PAGE_SIZE - 1)
                    .execute()
                )

            response, err = _execute_with_retry(do_query)
            if err is not None:
                if not first_page_seen:
                    # Likely the column variant doesn't exist for this schema; try the other one.
                    break
                app.logger.warning(
                    f"Inventory page offset={offset} col={store_col} failed after retries: {err}"
                )
                partial = True
                consecutive_failures += 1
                if consecutive_failures >= 3:
                    app.logger.error(
                        f"Aborting inventory pagination for store {store_id} col={store_col} after repeated failures"
                    )
                    break
                offset += _STORE_INVENTORY_PAGE_SIZE
                continue

            first_page_seen = True
            consecutive_failures = 0
            batch = response.data or []
            for row in batch:
                key = str(
                    row.get("id")
                    or f"{row.get('productid') or row.get('productId')}::{row.get('assignedat') or row.get('updatedat') or ''}"
                )
                if key in seen:
                    continue
                seen.add(key)
                rows.append(row)

            if len(batch) < _STORE_INVENTORY_PAGE_SIZE:
                break  # last page
            offset += _STORE_INVENTORY_PAGE_SIZE
    return rows, partial


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
    # Only apply limit for search queries; return all products for the full listing
    if search and limit:
        return final_products[:limit]
    return final_products


def _products_cache_key(user_id: str, search: str, limit: int):
    return f"{user_id}:{search}:{limit}"


def _build_products_response(
    items,
    fallback_used: bool,
    data_source: str,
    cached: bool = False,
    partial: bool = False,
    cache_age: float = None,
):
    response = jsonify(items)
    response.headers["X-Fallback-Used"] = "1" if fallback_used else "0"
    response.headers["X-Data-Source"] = data_source
    response.headers["X-Products-Cached"] = "1" if cached else "0"
    response.headers["X-Partial"] = "1" if partial else "0"
    if cache_age is not None:
        response.headers["X-Cache-Age"] = f"{int(cache_age)}"
    return response


def _build_products_from_inventory(rows, search: str = ""):
    """Map joined inventory+product rows to the API product shape."""
    search_lower = search.lower() if search else ""
    final_products = []
    seen_final_ids = set()

    for inv_item in rows:
        product_info = inv_item.get("products")
        if isinstance(product_info, list):
            product_info = product_info[0] if product_info else None
        if not product_info:
            continue

        product_id = str(
            product_info.get("id")
            or inv_item.get("productid")
            or inv_item.get("productId")
            or ""
        )
        if not product_id or product_id in seen_final_ids:
            continue

        if search_lower:
            name_match = search_lower in str(product_info.get("name", "")).lower()
            barcode_match = search_lower in str(product_info.get("barcode", ""))
            if not name_match and not barcode_match:
                continue

        seen_final_ids.add(product_id)
        final_products.append(
            {
                "id": product_id,
                "name": product_info.get("name", "Unknown Product"),
                "barcode": product_info.get("barcode", ""),
                "barcodes": product_info.get("barcode", ""),
                "selling_price": product_info.get("selling_price", 0),
                "price": product_info.get("price", 0),
                "tax": _extract_hsn_tax(product_info),
                "hsn_code_id": product_info.get("hsn_code_id"),
                "hsn_code": _extract_hsn_code(product_info),
                "stock": inv_item.get("quantity", 0),
                "quantity": inv_item.get("quantity", 0),
                "store_quantity": inv_item.get("quantity", 0),
                "minstocklevel": inv_item.get("minstocklevel", 0),
                "maxstocklevel": inv_item.get("maxstocklevel", None),
                "assignedat": inv_item.get("assignedat"),
                "updatedat": inv_item.get("updatedat"),
                "storeid": inv_item.get("storeid") or inv_item.get("storeId"),
                "inventory_id": inv_item.get("id"),
            }
        )

    final_products.sort(key=lambda p: str(p.get("name", "")).lower())
    return final_products


def _perform_cloud_products_fetch(supabase, store_id, search: str = ""):
    """Returns (final_products, partial_flag, raw_inv_rows, product_map).
    Raises only on truly unexpected exceptions; per-page failures surface as partial=True.
    """
    rows, partial = _get_store_inventory_with_products(supabase, str(store_id))
    final_products = _build_products_from_inventory(rows, search=search)
    product_map = {}
    for row in rows:
        product_info = row.get("products")
        if isinstance(product_info, list):
            product_info = product_info[0] if product_info else None
        if isinstance(product_info, dict) and product_info.get("id"):
            product_map[str(product_info["id"])] = product_info
    return final_products, partial, rows, product_map


def _spawn_background_products_refresh(cache_key: str, user_id: str, store_id: str, search: str):
    """Refresh the cloud cache in a background thread (stale-while-revalidate)."""
    if search:
        return  # only the unfiltered listing is cached
    with _PRODUCTS_BG_REFRESH_LOCK:
        if cache_key in _PRODUCTS_BG_REFRESH_INFLIGHT:
            return
        _PRODUCTS_BG_REFRESH_INFLIGHT.add(cache_key)

    real_app = app._get_current_object()

    def worker():
        try:
            with real_app.app_context():
                supabase = get_supabase_client()
                if getattr(supabase, "is_offline_fallback", False):
                    return
                final_products, partial, rows, product_map = _perform_cloud_products_fetch(
                    supabase, store_id, ""
                )
                if partial:
                    real_app.logger.info(
                        f"Background refresh skipped cache write for store {store_id} (partial result)"
                    )
                    return
                set_cloud_products_cache(cache_key, str(store_id), final_products)
                _refresh_local_products_snapshot(str(user_id), str(store_id), rows, product_map)
                real_app.logger.info(
                    f"Background refresh updated cache for store {store_id}: {len(final_products)} products"
                )
        except Exception as err:
            real_app.logger.warning(f"Background products refresh failed: {err}")
        finally:
            with _PRODUCTS_BG_REFRESH_LOCK:
                _PRODUCTS_BG_REFRESH_INFLIGHT.discard(cache_key)

    threading.Thread(target=worker, daemon=True).start()


def _refresh_local_products_snapshot(user_id: str, store_id: str, all_inv_rows, product_map) -> None:
    """Best-effort sync of local JSON fallback snapshots from cloud data."""
    try:
        user_stores = read_json_file(USER_STORES_FILE, [])
        user_stores = [
            row for row in user_stores
            if str(row.get("userId") or row.get("userid")) != str(user_id)
        ]
        user_stores.append({"userId": str(user_id), "storeId": str(store_id)})
        write_json_file(USER_STORES_FILE, user_stores)

        existing_inventory = read_json_file(STOREINVENTORY_FILE, [])
        kept_inventory = [
            row for row in existing_inventory
            if str(row.get("storeid") or row.get("storeId")) != str(store_id)
        ]
        new_inventory = []
        for row in all_inv_rows:
            product_id = row.get("productid") or row.get("productId")
            if not product_id:
                continue
            new_inventory.append({
                "id": row.get("id"),
                "storeid": row.get("storeid") or row.get("storeId") or store_id,
                "productid": product_id,
                "quantity": row.get("quantity", 0),
                "minstocklevel": row.get("minstocklevel", 0),
                "maxstocklevel": row.get("maxstocklevel"),
                "assignedat": row.get("assignedat"),
                "updatedat": row.get("updatedat"),
            })
        write_json_file(STOREINVENTORY_FILE, kept_inventory + new_inventory)

        existing_products = read_json_file(PRODUCTS_FILE, [])
        products_by_id = {
            str(p.get("id")): p
            for p in existing_products
            if isinstance(p, dict) and p.get("id")
        }
        for product in product_map.values():
            pid = str(product.get("id") or "")
            if not pid:
                continue
            products_by_id[pid] = {
                **products_by_id.get(pid, {}),
                "id": pid,
                "name": product.get("name", "Unknown Product"),
                "barcode": product.get("barcode", ""),
                "selling_price": product.get("selling_price", 0),
                "price": product.get("price", 0),
                "hsn_code_id": product.get("hsn_code_id"),
                "hsn_code": _extract_hsn_code(product),
                "tax": _extract_hsn_tax(product),
            }
        write_json_file(PRODUCTS_FILE, list(products_by_id.values()))
    except Exception as snapshot_error:
        app.logger.warning(f"Local snapshot refresh skipped: {snapshot_error}")


@product_bp.route('/products', methods=['GET'], strict_slashes=False)
@require_auth
def get_products():
    """Get products from current user's store inventory"""
    current_user_id = get_jwt_identity()
    search = request.args.get('search', '').strip()
    limit = request.args.get('limit', 5000, type=int)

    cache_key = _products_cache_key(str(current_user_id), search, limit)
    now_ts = time.time()
    fail_until = float(_PRODUCTS_CLOUD_FAIL_UNTIL.get(cache_key, 0))
    cached_cloud, cached_age = get_cloud_products_cache_with_age(
        cache_key, _PRODUCTS_CLOUD_CACHE_TTL_SECONDS
    )

    if now_ts < fail_until and not search:
        if cached_cloud is not None:
            return _build_products_response(
                cached_cloud,
                fallback_used=False,
                data_source="cloud_cache",
                cached=True,
                cache_age=cached_age,
            ), 200
        cached = _PRODUCTS_FALLBACK_CACHE.get(cache_key)
        if cached and now_ts - float(cached.get("ts", 0)) <= _PRODUCTS_FALLBACK_CACHE_TTL_SECONDS:
            return _build_products_response(
                cached.get("items", []),
                fallback_used=True,
                data_source="local_snapshot",
                cached=True,
            ), 200

        local_items = _build_local_products_response(current_user_id, search, limit)
        _PRODUCTS_FALLBACK_CACHE[cache_key] = {"ts": now_ts, "items": local_items}
        return _build_products_response(
            local_items, fallback_used=True, data_source="local_snapshot", cached=False
        ), 200

    try:
        app.logger.info(f"User {current_user_id} fetching store inventory products")

        supabase = get_supabase_client()
        if getattr(supabase, "is_offline_fallback", False):
            local_items = _build_local_products_response(current_user_id, search, limit)
            _PRODUCTS_FALLBACK_CACHE[cache_key] = {"ts": time.time(), "items": local_items}
            return _build_products_response(
                local_items, fallback_used=True, data_source="local_snapshot", cached=False
            ), 200

        user_store_rows = _get_user_store_rows(supabase, str(current_user_id))
        if not user_store_rows:
            app.logger.warning(f"No store assigned to user {current_user_id}; trying local products fallback")
            local_items = _build_local_products_response(current_user_id, search, limit)
            return _build_products_response(
                local_items, fallback_used=True, data_source="local_snapshot", cached=False
            ), 200

        store_id = _extract_store_id_from_user_store_row(user_store_rows[0])
        if not store_id:
            app.logger.warning(
                f"Store mapping row found without store ID for user {current_user_id}; trying local products fallback"
            )
            local_items = _build_local_products_response(current_user_id, search, limit)
            return _build_products_response(
                local_items, fallback_used=True, data_source="local_snapshot", cached=False
            ), 200

        # Stale-while-revalidate: serve fresh-enough cache instantly; if it's older
        # than half-life, kick off a background refresh so the next request is fresh.
        if not search and cached_cloud is not None:
            if cached_age is not None and cached_age > _PRODUCTS_CACHE_STALE_AFTER_SECONDS:
                _spawn_background_products_refresh(
                    cache_key, str(current_user_id), str(store_id), search
                )
            return _build_products_response(
                cached_cloud,
                fallback_used=False,
                data_source="cloud_cache",
                cached=True,
                cache_age=cached_age,
            ), 200

        app.logger.info(f"Fetching inventory for store: {store_id}")

        # Single joined paginated fetch (inventory + products + hsn_codes), with retries.
        final_products, partial, all_inv_rows, product_map = _perform_cloud_products_fetch(
            supabase, str(store_id), search
        )

        if not all_inv_rows and not partial:
            app.logger.info(f"No inventory found for store {store_id}")
            return _build_products_response(
                [], fallback_used=False, data_source="cloud", partial=False
            ), 200

        nonzero = sum(1 for p in final_products if (p.get("stock") or 0) > 0)
        sample = [(p["name"], p.get("stock")) for p in final_products[:3]]
        app.logger.info(
            f"Returning {len(final_products)} products — {nonzero} with stock>0, "
            f"partial={partial}, sample: {sample}"
        )

        # Critical guard: never cache or persist a partial fetch — that's how stale
        # incomplete data poisoned both layers under the old code.
        if not search and not partial:
            set_cloud_products_cache(cache_key, str(store_id), final_products)
            _refresh_local_products_snapshot(
                str(current_user_id), str(store_id), all_inv_rows, product_map
            )
            _PRODUCTS_CLOUD_FAIL_UNTIL.pop(cache_key, None)
        elif partial:
            app.logger.warning(
                f"Skipping cache/snapshot writes for store {store_id} — partial result"
            )

        return _build_products_response(
            final_products,
            fallback_used=False,
            data_source="cloud",
            partial=partial,
        ), 200

    except Exception as e:
        app.logger.error(f"Error fetching store inventory products: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        if cached_cloud is not None:
            return _build_products_response(
                cached_cloud,
                fallback_used=False,
                data_source="cloud_cache",
                cached=True,
                cache_age=cached_age,
            ), 200
        _PRODUCTS_CLOUD_FAIL_UNTIL[cache_key] = time.time() + _PRODUCTS_FAIL_COOLDOWN_SECONDS
        local_items = _build_local_products_response(current_user_id, search, limit)
        _PRODUCTS_FALLBACK_CACHE[cache_key] = {"ts": time.time(), "items": local_items}
        return _build_products_response(
            local_items, fallback_used=True, data_source="local_snapshot", cached=False
        ), 200


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
