from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from postgrest.exceptions import APIError
from utils.connection_pool import get_supabase_client
from datetime import datetime, timezone, timedelta
import threading
import traceback
import time
from helpers.utils import read_json_file, write_json_file
from config.config import BILLS_FILE, BILL_IDEMPOTENCY_FILE

from services.billing_service import create_bill_transaction
from utils.offline_bill_queue import enqueue_bill_create
from data_access.data_access import update_both_inventory_and_product_stock
from utils.bill_item_snapshot import get_bill_item_snapshots, replace_bill_item_snapshots

billing_bp = Blueprint('billing', __name__)
EDIT_WINDOW_HOURS = 24
EDITABLE_STATUSES = {"completed", "paid", "pending"}
_bill_idempotency_lock = threading.Lock()
_BILL_IDEMPOTENCY_TTL_HOURS = 48


def _idempotency_key(user_id, client_request_id):
    safe_user = str(user_id or "").strip()
    safe_request = str(client_request_id or "").strip()
    if not safe_user or not safe_request:
        return None
    return f"{safe_user}:{safe_request}"


def _parse_iso_datetime(raw_value):
    if not raw_value:
        return None
    try:
        parsed = datetime.fromisoformat(str(raw_value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def _get_bill_created_at_utc(bill):
    return _parse_iso_datetime(
        bill.get("created_at") or bill.get("timestamp") or bill.get("createdAt")
    )


def _build_edit_window_meta(bill):
    now_utc = datetime.now(timezone.utc)
    created_at_utc = _get_bill_created_at_utc(bill)
    status = str(bill.get("status") or "").lower()
    eligible_status = status in EDITABLE_STATUSES

    if not created_at_utc:
        return {
            "can_edit": False,
            "can_cancel": False,
            "edit_expires_at": None,
            "seconds_remaining": 0,
        }

    edit_expires_at = created_at_utc + timedelta(hours=EDIT_WINDOW_HOURS)
    seconds_remaining = max(0, int((edit_expires_at - now_utc).total_seconds()))
    in_window = seconds_remaining > 0
    can_mutate = in_window and eligible_status

    return {
        "can_edit": can_mutate,
        "can_cancel": can_mutate,
        "edit_expires_at": edit_expires_at.isoformat(),
        "seconds_remaining": seconds_remaining,
    }


def _fetch_bill_by_id(supabase, bill_id):
    response = (
        supabase.table("bills")
        .select("*")
        .eq("id", bill_id)
        .limit(1)
        .execute()
    )
    return response.data[0] if response.data else None


def _bill_has_items(supabase, bill_id):
    try:
        response = (
            supabase.table("billitems")
            .select("id")
            .eq("billid", bill_id)
            .limit(1)
            .execute()
        )
        return bool(response.data)
    except Exception:
        return False


def _log_bill_event(supabase, event_type, bill_id, message):
    """Best-effort bill event logger using notifications table."""
    try:
        supabase.table("notifications").insert(
            {
                "type": event_type,
                "notification": message,
                "related_id": bill_id,
                "is_read": False,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        ).execute()
    except Exception:
        # Optional logging should never break billing flow.
        pass


def _to_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _snapshot_match_key(product_id, quantity, price, total):
    return (
        str(product_id or ""),
        int(quantity or 0),
        round(_to_float(price, 0.0), 3),
        round(_to_float(total, 0.0), 3),
    )


def _pop_item_snapshot(snapshot_buckets, item):
    exact_key = _snapshot_match_key(
        item.get("productid"),
        item.get("quantity"),
        item.get("price"),
        item.get("total"),
    )
    exact_bucket = snapshot_buckets.get(exact_key) or []
    if exact_bucket:
        return exact_bucket.pop(0)

    loose_key = (
        str(item.get("productid") or ""),
        int(item.get("quantity") or 0),
    )
    loose_bucket = snapshot_buckets.get(loose_key) or []
    if loose_bucket:
        return loose_bucket.pop(0)
    return None


def _build_snapshot_buckets(rows):
    buckets = {}
    for row in rows or []:
        exact_key = _snapshot_match_key(
            row.get("productid"),
            row.get("quantity"),
            row.get("price"),
            row.get("total"),
        )
        buckets.setdefault(exact_key, []).append(row)

        loose_key = (
            str(row.get("productid") or ""),
            int(row.get("quantity") or 0),
        )
        buckets.setdefault(loose_key, []).append(row)
    return buckets


def _fetch_product_meta_map(supabase, product_ids):
    clean_ids = [str(pid) for pid in product_ids if pid]
    if not clean_ids:
        return {}

    response = (
        supabase.table("products")
        .select("id, name, barcode, price, selling_price, hsn_code_id, hsn_codes(hsn_code, tax)")
        .in_("id", clean_ids)
        .execute()
    )

    mapped = {}
    for row in response.data or []:
        hsn_ref = row.get("hsn_codes")
        if isinstance(hsn_ref, list):
            hsn_ref = hsn_ref[0] if hsn_ref else {}
        if not isinstance(hsn_ref, dict):
            hsn_ref = {}
        product_id = str(row.get("id") or "").strip()
        if not product_id:
            continue
        mapped[product_id] = {
            **row,
            "tax": hsn_ref.get("tax", row.get("tax")),
            "hsn_code": hsn_ref.get("hsn_code") or "",
        }
    return mapped


def _cleanup_bill_idempotency_map(raw_map):
    now = datetime.now(timezone.utc)
    cleaned = {}
    for key, value in (raw_map or {}).items():
        if not isinstance(value, dict):
            continue
        created_at = _parse_iso_datetime(value.get("created_at"))
        if not created_at:
            continue
        age_seconds = (now - created_at).total_seconds()
        if age_seconds <= _BILL_IDEMPOTENCY_TTL_HOURS * 3600:
            cleaned[key] = value
    return cleaned


def _read_bill_idempotency_map():
    raw = read_json_file(BILL_IDEMPOTENCY_FILE, {})
    if not isinstance(raw, dict):
        raw = {}
    return _cleanup_bill_idempotency_map(raw)


def _write_bill_idempotency_map(data):
    write_json_file(BILL_IDEMPOTENCY_FILE, data)


def _lookup_bill_by_request_id(client_request_id, user_id):
    scoped_key = _idempotency_key(user_id, client_request_id)
    if not scoped_key:
        return None
    with _bill_idempotency_lock:
        cache = _read_bill_idempotency_map()
        entry = cache.get(scoped_key)
        if not entry:
            # Backward compatibility for older unscoped cache keys.
            legacy_entry = cache.get(str(client_request_id).strip())
            if isinstance(legacy_entry, dict) and str(legacy_entry.get("user_id") or "") == str(user_id or ""):
                entry = legacy_entry
        if not entry:
            _write_bill_idempotency_map(cache)
            return None
        _write_bill_idempotency_map(cache)
        return entry.get("bill_id")


def _remember_bill_request(client_request_id, bill_id, user_id):
    scoped_key = _idempotency_key(user_id, client_request_id)
    if not scoped_key or not bill_id:
        return
    with _bill_idempotency_lock:
        cache = _read_bill_idempotency_map()
        cache[scoped_key] = {
            "bill_id": bill_id,
            "user_id": user_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        _write_bill_idempotency_map(cache)


def _cancel_bill_internal(bill_id, current_user_id, cancel_reason):
    supabase = get_supabase_client()
    bill = _fetch_bill_by_id(supabase, bill_id)
    if not bill:
        return jsonify({"message": "Bill not found"}), 404

    if str(bill.get("status") or "").lower() == "cancelled":
        return jsonify({"message": "Bill already cancelled"}), 409

    edit_meta = _build_edit_window_meta(bill)
    if not edit_meta["can_cancel"]:
        return jsonify(
            {"message": "Invoice cancel window expired or bill status is not cancellable", **edit_meta}
        ), 409

    store_id = bill.get("storeid")
    if not store_id:
        return jsonify({"message": "Store ID missing on bill"}), 400

    items_response = supabase.table("billitems").select("*").eq("billid", bill_id).execute()
    items = items_response.data if items_response.data else []

    stock_errors = []
    for item in items:
        product_id = item.get("productid")
        quantity = int(item.get("quantity") or 0)
        if not product_id or quantity <= 0:
            continue
        try:
            ok = update_both_inventory_and_product_stock(
                store_id=store_id,
                product_id=product_id,
                quantity_sold=-quantity,
            )
            if not ok:
                stock_errors.append(product_id)
        except Exception:
            stock_errors.append(product_id)

    now = datetime.now(timezone.utc).isoformat()
    update_data = {
        "status": "cancelled",
        "updated_at": now,
    }
    supabase.table("bills").update(update_data).eq("id", bill_id).execute()
    reason_suffix = f" (Reason: {cancel_reason})" if cancel_reason else ""
    _log_bill_event(
        supabase=supabase,
        event_type="invoice_cancelled",
        bill_id=bill_id,
        message=f"Invoice {bill_id} cancelled by user {current_user_id}{reason_suffix}",
    )

    response_payload = {
        "message": "Invoice cancelled successfully",
        "bill_id": bill_id,
        "cancel_reason": cancel_reason or None,
    }
    if stock_errors:
        response_payload["stock_update_errors"] = stock_errors
    return jsonify(response_payload), 200


@billing_bp.route('/bills', methods=['GET'])
@require_auth
def get_bills():
    """Get all bills with optional filtering"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching bills")
        
        store_id = request.args.get('store_id')
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        limit = request.args.get('limit', 100, type=int)
        
        supabase = get_supabase_client()
        
        # ✅ Include customer and store details via JOIN
        query = supabase.table('bills').select(
            '*, customers(name, phone, email, address), stores(name, address, phone)'
        )
        
        if store_id:
            query = query.eq('storeid', store_id)
        if start_date:
            query = query.gte('created_at', start_date)
        if end_date:
            query = query.lte('created_at', end_date)
        
        response = None
        max_retries = 2
        for attempt in range(max_retries + 1):
            try:
                response = query.limit(limit).order('created_at', desc=True).execute()
                break
            except APIError as api_error:
                if attempt >= max_retries:
                    raise api_error
                app.logger.warning(
                    f"Retrying bills fetch after APIError (attempt {attempt + 1}/{max_retries + 1}): {api_error}"
                )
                time.sleep(0.2 * (attempt + 1))

        bills = response.data if response and response.data else []
        for bill in bills:
            bill.update(_build_edit_window_meta(bill))

        app.logger.info(f"✅ Fetched {len(bills)} bills")
        result = jsonify(bills)
        result.headers["X-Bills-Fallback-Used"] = "0"
        return result, 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching bills: {str(e)}")
        app.logger.error(traceback.format_exc())
        cached_bills = read_json_file(BILLS_FILE, [])
        if store_id:
            cached_bills = [b for b in cached_bills if str(b.get("storeid")) == str(store_id)]
        result = jsonify(cached_bills[:limit])
        result.headers["X-Bills-Fallback-Used"] = "1"
        return result, 200


@billing_bp.route('/bills/<bill_id>', methods=['GET'])
@require_auth
def get_bill(bill_id):
    """Get a specific bill by ID with store and customer details"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching bill {bill_id}")
        
        supabase = get_supabase_client()
        
        # ✅ Use JOIN to get store and customer details
        response = supabase.table('bills') \
            .select('*, stores(name, address, phone), customers(name, phone, email, address)') \
            .eq('id', bill_id) \
            .execute()
        
        if not response.data or len(response.data) == 0:
            return jsonify({"message": "Bill not found"}), 404
        
        bill = response.data[0]
        bill.update(_build_edit_window_meta(bill))
        app.logger.info(f"✅ Bill found: {bill_id}")
        return jsonify(bill), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching bill {bill_id}: {str(e)}")
        app.logger.error(traceback.format_exc())
        cached_bills = read_json_file(BILLS_FILE, [])
        bill = next((b for b in cached_bills if str(b.get("id")) == str(bill_id)), None)
        if not bill:
            return jsonify({"message": "Bill not found"}), 404
        return jsonify(bill), 200


@billing_bp.route('/bills', methods=['POST'])
@require_auth
def create_bill():
    """Create a new bill. If Supabase is unavailable, queue it for later sync."""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json() or {}
        app.logger.info(f"💰 User {current_user_id} creating new bill")
        client_request_id = str(data.get("_client_request_id") or "").strip()

        existing_bill_id = _lookup_bill_by_request_id(client_request_id, current_user_id)
        if existing_bill_id:
            supabase = get_supabase_client()
            existing_bill = _fetch_bill_by_id(supabase, existing_bill_id) if supabase else None
            if existing_bill and _bill_has_items(supabase, existing_bill_id):
                app.logger.info(
                    f"🔁 Duplicate bill request replayed for request_id={client_request_id}, bill_id={existing_bill_id}"
                )
                return jsonify(
                    {
                        "message": "Bill already processed",
                        "bill_id": existing_bill_id,
                        "bill": existing_bill,
                        "idempotent_replay": True,
                    }
                ), 200

        try:
            response_data = create_bill_transaction(current_user_id=current_user_id, data=data)
            _remember_bill_request(client_request_id, response_data.get("bill_id"), current_user_id)
            app.logger.info(f"✅ Bill {response_data.get('bill_id')} completed")
            return jsonify(response_data), 201
        except ValueError as e:
            return jsonify({"message": str(e)}), 400
        except Exception as e:
            app.logger.error(f"❌ Immediate bill create failed; queueing offline: {e}")
            app.logger.error(traceback.format_exc())

            queue_result = enqueue_bill_create(current_user_id=current_user_id, bill_payload=data)
            return jsonify({
                "message": "System offline. Invoice queued and will sync automatically when internet returns.",
                "queued": True,
                "queue_id": queue_result["queue_id"],
                "bill_id": queue_result["bill_id"],
            }), 202

    except Exception as e:
        app.logger.error(f"❌ Error creating bill: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@billing_bp.route('/bills/<bill_id>', methods=['PUT'])
@require_auth
def update_bill(bill_id):
    """Update a bill"""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json()
        
        app.logger.info(f"User {current_user_id} updating bill {bill_id}")
        
        # Only allow updating certain fields
        allowed_fields = ['status', 'paymentmethod']
        update_data = {k: v for k, v in data.items() if k in allowed_fields}
        
        if not update_data:
            return jsonify({"message": "No valid fields to update"}), 400
        
        update_data['updated_at'] = datetime.now(timezone.utc).isoformat()
        
        supabase = get_supabase_client()
        response = supabase.table('bills').update(update_data).eq('id', bill_id).execute()
        
        if not response.data or len(response.data) == 0:
            return jsonify({"message": "Bill not found"}), 404
        
        updated_bill = response.data[0]
        app.logger.info(f"✅ Updated bill: {bill_id}")
        
        return jsonify(updated_bill), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error updating bill {bill_id}: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@billing_bp.route('/bills/<bill_id>', methods=['DELETE'])
@require_auth
def delete_bill(bill_id):
    """Legacy endpoint: cancel a bill using the same safe flow as /cancel."""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} deleting bill {bill_id} via legacy endpoint")
        return _cancel_bill_internal(
            bill_id=bill_id,
            current_user_id=current_user_id,
            cancel_reason="Cancelled via legacy DELETE endpoint",
        )
    except Exception as e:
        app.logger.error(f"❌ Error deleting bill {bill_id}: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@billing_bp.route('/bills/stats', methods=['GET'])
@require_auth
def get_billing_stats():
    """Get billing statistics"""
    try:
        current_user_id = get_jwt_identity()
        store_id = request.args.get('store_id')
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        
        supabase = get_supabase_client()
        query = supabase.table('bills').select('total, created_at, status')
        
        if store_id:
            query = query.eq('storeid', store_id)
        if start_date:
            query = query.gte('created_at', start_date)
        if end_date:
            query = query.lte('created_at', end_date)
        
        # Only include completed bills in stats
        query = query.eq('status', 'completed')
        
        response = query.execute()
        bills = response.data if response.data else []
        
        total_sales = sum(bill['total'] for bill in bills)
        total_bills = len(bills)
        avg_bill_amount = total_sales / total_bills if total_bills > 0 else 0
        
        stats = {
            'total_sales': total_sales,
            'total_bills': total_bills,
            'average_bill_amount': avg_bill_amount
        }
        
        app.logger.info(f"User {current_user_id} fetched billing stats: {stats}")
        return jsonify(stats), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching billing stats: {str(e)}")
        app.logger.error(traceback.format_exc())
        cached_bills = read_json_file(BILLS_FILE, [])
        if store_id:
            cached_bills = [b for b in cached_bills if str(b.get("storeid")) == str(store_id)]
        completed = [b for b in cached_bills if str(b.get("status")) == "completed"]
        total_sales = sum(float(b.get('total') or 0) for b in completed)
        total_bills = len(completed)
        avg_bill_amount = total_sales / total_bills if total_bills > 0 else 0
        return jsonify({
            'total_sales': total_sales,
            'total_bills': total_bills,
            'average_bill_amount': avg_bill_amount
        }), 200


@billing_bp.route('/bills/<bill_id>/items', methods=['GET'])
@require_auth
def get_bill_items(bill_id):
    """Get all items for a specific bill"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching items for bill {bill_id}")
        
        supabase = get_supabase_client()
        
        # Get bill items first, then enrich with robust product + snapshot fallback.
        response = (
            supabase.table('billitems')
            .select('*')
            .eq('billid', bill_id)
            .order('id')
            .execute()
        )
        items = response.data if response.data else []
        product_map = _fetch_product_meta_map(supabase, [it.get("productid") for it in items])
        snapshot_buckets = _build_snapshot_buckets(get_bill_item_snapshots(bill_id))
        enriched_items = []
        for item in items:
            snapshot = _pop_item_snapshot(snapshot_buckets, item) or {}
            product = product_map.get(str(item.get("productid") or ""), {})
            hsn_code = (
                snapshot.get("hsn_code")
                or product.get('hsn_code')
                or item.get("hsn_code")
                or item.get("hsnCode")
            )
            tax_percentage = item.get("tax_percentage")
            if tax_percentage is None:
                tax_percentage = item.get("taxPercentage")
            if tax_percentage is None:
                tax_percentage = snapshot.get("tax_percentage")
            if tax_percentage is None:
                tax_percentage = product.get('tax')
            if hsn_code:
                item['hsn_code'] = hsn_code
                item['hsnCode'] = hsn_code
            if tax_percentage is not None:
                item['tax_percentage'] = tax_percentage
                item['taxPercentage'] = tax_percentage
                product['tax'] = tax_percentage
            if snapshot.get("name") and not product.get("name"):
                product["name"] = snapshot.get("name")
            if snapshot.get("barcode") and not product.get("barcode"):
                product["barcode"] = snapshot.get("barcode")
            item["products"] = product
            enriched_items.append(item)
        
        app.logger.info(f"✅ Fetched {len(enriched_items)} items for bill {bill_id}")
        return jsonify(enriched_items), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching bill items: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify([]), 200


@billing_bp.route('/bills/<bill_id>/edit-payload', methods=['GET'])
@require_auth
def get_bill_edit_payload(bill_id):
    """Get bill + items payload for invoice edit mode."""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching edit payload for bill {bill_id}")

        supabase = get_supabase_client()
        bill_response = (
            supabase.table("bills")
            .select("*, customers(name, phone, email, address), stores(name, address, phone)")
            .eq("id", bill_id)
            .limit(1)
            .execute()
        )
        if not bill_response.data:
            return jsonify({"message": "Bill not found"}), 404

        bill = bill_response.data[0]
        edit_meta = _build_edit_window_meta(bill)
        if not edit_meta["can_edit"]:
            return jsonify(
                {
                    "message": "Invoice edit window expired or bill status is not editable",
                    **edit_meta,
                }
            ), 409

        items_response = (
            supabase.table("billitems")
            .select("*, products(name, barcode, selling_price, hsn_codes(tax, hsn_code))")
            .eq("billid", bill_id)
            .execute()
        )
        raw_items = items_response.data if items_response.data else []
        snapshot_buckets = _build_snapshot_buckets(get_bill_item_snapshots(bill_id))

        items = []
        for item in raw_items:
            product = item.get("products") or {}
            hsn_ref = product.get("hsn_codes")
            if isinstance(hsn_ref, list):
                hsn_ref = hsn_ref[0] if hsn_ref else {}
            if not isinstance(hsn_ref, dict):
                hsn_ref = {}
            snapshot = _pop_item_snapshot(snapshot_buckets, item) or {}
            tax_percentage = item.get("tax_percentage", item.get("taxPercentage"))
            if tax_percentage is None:
                tax_percentage = snapshot.get("tax_percentage")
            if tax_percentage is None:
                tax_percentage = hsn_ref.get("tax")
            hsn_code = (
                item.get("hsn_code")
                or item.get("hsnCode")
                or snapshot.get("hsn_code")
                or hsn_ref.get("hsn_code")
                or ""
            )
            name = product.get("name") or snapshot.get("name") or item.get("name") or "Unknown Item"
            barcode = product.get("barcode") or snapshot.get("barcode") or ""

            items.append(
                {
                    "id": item.get("id"),
                    "productId": item.get("productid"),
                    "name": name,
                    "quantity": item.get("quantity") or 0,
                    "price": float(item.get("price") or 0),
                    "total": float(item.get("total") or 0),
                    "barcodes": barcode,
                    "taxPercentage": float(tax_percentage or 0),
                    "hsnCode": hsn_code,
                }
            )

        app.logger.info(f"✅ Edit payload fetched for bill {bill_id} with {len(items)} items")
        return jsonify({"bill": {**bill, **edit_meta}, "items": items, **edit_meta}), 200
    except Exception as e:
        app.logger.error(f"❌ Error fetching edit payload for {bill_id}: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@billing_bp.route('/bills/<bill_id>/revise', methods=['PUT'])
@require_auth
def revise_bill(bill_id):
    """Revise an existing bill within the 24-hour edit window."""
    try:
        current_user_id = get_jwt_identity()
        payload = request.get_json() or {}
        app.logger.info(f"User {current_user_id} revising bill {bill_id}")

        supabase = get_supabase_client()
        existing_bill = _fetch_bill_by_id(supabase, bill_id)
        if not existing_bill:
            return jsonify({"message": "Bill not found"}), 404

        edit_meta = _build_edit_window_meta(existing_bill)
        if not edit_meta["can_edit"]:
            return jsonify(
                {"message": "Invoice edit window expired or bill status is not editable", **edit_meta}
            ), 409

        store_id = payload.get("store_id") or existing_bill.get("storeid")
        if not store_id:
            return jsonify({"message": "Store ID is required"}), 400

        new_items = payload.get("items") or []
        if not isinstance(new_items, list) or len(new_items) == 0:
            return jsonify({"message": "At least one item is required for revision"}), 400

        old_items_response = (
            supabase.table("billitems")
            .select("*")
            .eq("billid", bill_id)
            .execute()
        )
        old_items = old_items_response.data if old_items_response.data else []

        stock_errors = []
        # Restock previous bill quantities first.
        for old_item in old_items:
            product_id = old_item.get("productid")
            qty = int(old_item.get("quantity") or 0)
            if not product_id or qty <= 0:
                continue
            try:
                ok = update_both_inventory_and_product_stock(
                    store_id=store_id,
                    product_id=product_id,
                    quantity_sold=-qty,
                )
                if not ok:
                    stock_errors.append(f"restock failed for {product_id}")
            except Exception:
                stock_errors.append(f"restock error for {product_id}")

        # Apply stock deduction for revised items.
        for item in new_items:
            product_id = item.get("product_id") or item.get("productId")
            qty = int(item.get("quantity") or 0)
            if not product_id or qty <= 0:
                continue
            try:
                ok = update_both_inventory_and_product_stock(
                    store_id=store_id,
                    product_id=product_id,
                    quantity_sold=qty,
                )
                if not ok:
                    stock_errors.append(f"deduct failed for {product_id}")
            except Exception:
                stock_errors.append(f"deduct error for {product_id}")

        # Replace bill items rows.
        supabase.table("billitems").delete().eq("billid", bill_id).execute()

        now = datetime.now(timezone.utc).isoformat()
        insert_rows = []
        valid_source_items = []
        for item in new_items:
            product_id = item.get("product_id") or item.get("productId")
            quantity = int(item.get("quantity") or 0)
            unit_price = float(item.get("unit_price") or item.get("unitPrice") or item.get("price") or 0)
            item_total = float(item.get("item_total") or item.get("itemTotal") or item.get("total") or (unit_price * quantity))
            if not product_id or quantity <= 0:
                continue
            insert_rows.append(
                {
                    "billid": bill_id,
                    "productid": product_id,
                    "quantity": quantity,
                    "price": unit_price,
                    "total": item_total,
                    "created_at": now,
                    "updated_at": now,
                }
            )
            valid_source_items.append(item)

        if not insert_rows:
            return jsonify({"message": "No valid items found for revision"}), 400

        supabase.table("billitems").insert(insert_rows).execute()
        product_map = _fetch_product_meta_map(
            supabase,
            [row.get("productid") for row in insert_rows],
        )
        snapshot_rows = []
        for row, src in zip(insert_rows, valid_source_items):
            product_id = str(row.get("productid") or "")
            product = product_map.get(product_id, {})
            tax_percentage = src.get("tax_percentage", src.get("taxPercentage"))
            if tax_percentage is None:
                tax_percentage = product.get("tax")
            hsn_code = src.get("hsn_code", src.get("hsnCode"))
            if not hsn_code:
                hsn_code = product.get("hsn_code")
            snapshot_rows.append(
                {
                    "productid": product_id,
                    "quantity": row.get("quantity"),
                    "price": row.get("price"),
                    "total": row.get("total"),
                    "tax_percentage": _to_float(tax_percentage, 0.0),
                    "hsn_code": str(hsn_code or "").strip(),
                    "name": str(src.get("name") or product.get("name") or "").strip(),
                    "barcode": str(src.get("barcode") or src.get("barcodes") or product.get("barcode") or "").strip(),
                    "created_at": now,
                }
            )
        try:
            replace_bill_item_snapshots(bill_id, snapshot_rows)
        except Exception:
            app.logger.warning(f"Could not update bill item snapshots for revised bill {bill_id}")

        update_data = {
            "subtotal": float(payload.get("subtotal") or existing_bill.get("subtotal") or 0),
            "tax_amount": float(payload.get("tax_amount") or existing_bill.get("tax_amount") or 0),
            "discount_percentage": float(payload.get("discount_percentage") or 0),
            "discount_amount": float(payload.get("discount_amount") or 0),
            "total": float(payload.get("total_amount") or payload.get("total") or existing_bill.get("total") or 0),
            "paymentmethod": payload.get("payment_method") or payload.get("paymentMethod") or existing_bill.get("paymentmethod") or "Cash",
            "status": existing_bill.get("status") or "completed",
            "updated_at": now,
        }
        bill_update_response = supabase.table("bills").update(update_data).eq("id", bill_id).execute()
        updated_bill = bill_update_response.data[0] if bill_update_response.data else None
        _log_bill_event(
            supabase=supabase,
            event_type="invoice_revised",
            bill_id=bill_id,
            message=f"Invoice {bill_id} revised by user {current_user_id}",
        )

        response_payload = {
            "message": "Invoice revised successfully",
            "bill_id": bill_id,
            "bill": updated_bill,
            "items_updated": len(insert_rows),
        }
        if stock_errors:
            response_payload["stock_update_errors"] = stock_errors

        return jsonify(response_payload), 200
    except Exception as e:
        app.logger.error(f"❌ Error revising bill {bill_id}: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@billing_bp.route('/bills/<bill_id>/cancel', methods=['POST'])
@require_auth
def cancel_bill(bill_id):
    """Cancel bill within edit window and restock all items."""
    try:
        current_user_id = get_jwt_identity()
        payload = request.get_json() or {}
        cancel_reason = str(payload.get("cancel_reason") or "").strip()
        app.logger.info(f"User {current_user_id} cancelling bill {bill_id}")

        return _cancel_bill_internal(
            bill_id=bill_id,
            current_user_id=current_user_id,
            cancel_reason=cancel_reason,
        )
    except Exception as e:
        app.logger.error(f"❌ Error cancelling bill {bill_id}: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@billing_bp.route('/bills/<bill_id>/replacements', methods=['GET'])
@require_auth
def get_bill_replacements(bill_id):
    """Get replacement rows for a specific bill"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching replacements for bill {bill_id}")

        supabase = get_supabase_client()
        response = supabase.table('replacements') \
            .select('*') \
            .eq('bill_id', bill_id) \
            .execute()

        replacements = response.data if response.data else []
        app.logger.info(f"✅ Fetched {len(replacements)} replacements for bill {bill_id}")
        return jsonify(replacements), 200
    except Exception as e:
        app.logger.error(f"❌ Error fetching bill replacements: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify([]), 200


@billing_bp.route('/bills/<bill_id>/events', methods=['GET'])
@require_auth
def get_bill_events(bill_id):
    """Get bill audit events (revision/cancellation) from notifications table."""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching bill events for {bill_id}")

        supabase = get_supabase_client()
        event_type = request.args.get("type", "").strip().lower()
        limit = request.args.get("limit", 50, type=int)
        offset = request.args.get("offset", 0, type=int)
        if limit is None or limit <= 0:
            limit = 50
        if limit > 200:
            limit = 200
        if offset is None or offset < 0:
            offset = 0

        query = (
            supabase.table("notifications")
            .select("id, type, notification, related_id, created_at")
            .eq("related_id", bill_id)
        )

        allowed_types = ["invoice_revised", "invoice_cancelled"]
        if event_type in allowed_types:
            query = query.eq("type", event_type)
        else:
            query = query.in_("type", allowed_types)

        response = (
            query.order("created_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )

        events = response.data if response.data else []
        has_more = len(events) == limit
        return jsonify(
            {
                "events": events,
                "offset": offset,
                "limit": limit,
                "next_offset": offset + len(events),
                "has_more": has_more,
            }
        ), 200
    except Exception as e:
        app.logger.error(f"❌ Error fetching bill events for {bill_id}: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify([]), 200
