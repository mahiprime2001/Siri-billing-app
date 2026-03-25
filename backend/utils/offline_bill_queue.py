import threading
import uuid
import os
from datetime import datetime, timezone
from typing import Dict, Any
import re
from zoneinfo import ZoneInfo

from config.config import OFFLINE_BILL_QUEUE_FILE, BILLS_FILE, STOREINVENTORY_FILE, PRODUCTS_FILE, JSON_DIR
from helpers.utils import read_json_file, write_json_file
from services.billing_service import create_bill_transaction
from utils.connection_pool import get_supabase_client

_queue_lock = threading.Lock()
MAX_RETRIES = 100
INVOICE_ID_REGEX = re.compile(r"^INV-(\d{8})(\d{4})$")
IST_ZONE = ZoneInfo("Asia/Kolkata")
BILL_ITEMS_FILE = os.path.join(JSON_DIR, "billitems.json")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_invoice_prefix() -> str:
    return f"INV-{datetime.now(IST_ZONE).strftime('%d%m%Y')}"


def _extract_serial(invoice_id: str, prefix: str) -> int:
    if not invoice_id or not invoice_id.startswith(prefix):
        return 0
    match = INVOICE_ID_REGEX.match(str(invoice_id))
    if not match:
        return 0
    try:
        return int(match.group(2))
    except (TypeError, ValueError):
        return 0


def _next_offline_invoice_id(existing_queue) -> str:
    prefix = _today_invoice_prefix()
    max_serial = 0

    bills = read_json_file(BILLS_FILE, [])
    if isinstance(bills, list):
        for bill in bills:
            max_serial = max(max_serial, _extract_serial(str(bill.get("id") or ""), prefix))

    for queued in existing_queue or []:
        max_serial = max(max_serial, _extract_serial(str(queued.get("forced_bill_id") or ""), prefix))
        payload = queued.get("payload") or {}
        max_serial = max(max_serial, _extract_serial(str(payload.get("_forced_bill_id") or ""), prefix))

    return f"{prefix}{max_serial + 1:04d}"


def _upsert_local_bill_snapshot(current_user_id: str, payload: Dict[str, Any], forced_bill_id: str):
    now = _utc_now()
    event_time = str(payload.get("timestamp") or payload.get("created_at") or now)
    bills = read_json_file(BILLS_FILE, [])
    if not isinstance(bills, list):
        bills = []

    bill_row = {
        "id": forced_bill_id,
        "storeid": payload.get("store_id"),
        "customerid": payload.get("customer_id") or "walk-in-customer",
        "userid": current_user_id,
        "subtotal": payload.get("subtotal", payload.get("total_amount", 0)),
        "tax_percentage": payload.get("tax_percentage", 0),
        "tax_amount": payload.get("tax_amount", 0),
        "discount_percentage": payload.get("discount_percentage", 0),
        "discount_amount": payload.get("discount_amount", 0),
        "total": payload.get("total_amount", 0),
        "paymentmethod": payload.get("payment_method", "Cash"),
        "timestamp": event_time,
        "status": "completed",
        "createdby": current_user_id,
        "created_at": event_time,
        "updated_at": now,
    }

    existing_idx = next((idx for idx, b in enumerate(bills) if str(b.get("id")) == str(forced_bill_id)), None)
    if existing_idx is None:
        bills.append(bill_row)
    else:
        merged = dict(bills[existing_idx])
        merged.update({k: v for k, v in bill_row.items() if v is not None})
        merged["updated_at"] = now
        bills[existing_idx] = merged
    write_json_file(BILLS_FILE, bills)


def _upsert_local_billitems_snapshot(payload: Dict[str, Any], forced_bill_id: str):
    now = _utc_now()
    raw_items = payload.get("items") or []
    if not isinstance(raw_items, list):
        return

    billitems = read_json_file(BILL_ITEMS_FILE, [])
    if not isinstance(billitems, list):
        billitems = []

    billitems = [row for row in billitems if str(row.get("billid")) != str(forced_bill_id)]

    for idx, item in enumerate(raw_items):
        if not isinstance(item, dict):
            continue
        quantity = int(item.get("quantity") or 0)
        unit_price = float(item.get("unit_price") or 0)
        item_total = float(item.get("item_total") or unit_price * quantity)
        billitems.append(
            {
                "id": f"BI-{forced_bill_id}-{idx + 1}",
                "billid": forced_bill_id,
                "productid": item.get("product_id"),
                "quantity": quantity,
                "unitprice": unit_price,
                "itemtotal": item_total,
                "tax_percentage": float(item.get("tax_percentage") or 0),
                "hsn_code": item.get("hsn_code") or "",
                "name": item.get("name") or "",
                "barcode": item.get("barcode") or "",
                "created_at": now,
                "updated_at": now,
            }
        )

    write_json_file(BILL_ITEMS_FILE, billitems)


def _apply_local_inventory_reduction(payload: Dict[str, Any]):
    store_id = str(payload.get("store_id") or "")
    raw_items = payload.get("items") or []
    if not store_id or not isinstance(raw_items, list):
        return

    inventory_rows = read_json_file(STOREINVENTORY_FILE, [])
    products = read_json_file(PRODUCTS_FILE, [])
    if not isinstance(inventory_rows, list):
        inventory_rows = []
    if not isinstance(products, list):
        products = []

    qty_by_product = {}
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        product_id = str(item.get("product_id") or "")
        if not product_id:
            continue
        qty_by_product[product_id] = qty_by_product.get(product_id, 0) + int(item.get("quantity") or 0)

    if not qty_by_product:
        return

    now = _utc_now()
    for row in inventory_rows:
        row_store_id = str(row.get("storeid") or row.get("storeId") or "")
        row_product_id = str(row.get("productid") or row.get("productId") or "")
        if row_store_id != store_id or row_product_id not in qty_by_product:
            continue
        current_qty = int(row.get("quantity") or 0)
        row["quantity"] = max(0, current_qty - qty_by_product[row_product_id])
        row["updatedat"] = now

    for product in products:
        pid = str(product.get("id") or "")
        if pid not in qty_by_product:
            continue
        current_stock = int(product.get("stock") or 0)
        product["stock"] = max(0, current_stock - qty_by_product[pid])
        product["updatedat"] = now

    write_json_file(STOREINVENTORY_FILE, inventory_rows)
    write_json_file(PRODUCTS_FILE, products)


def _persist_local_offline_bill_snapshot(current_user_id: str, payload: Dict[str, Any], forced_bill_id: str):
    _upsert_local_bill_snapshot(current_user_id=current_user_id, payload=payload, forced_bill_id=forced_bill_id)
    _upsert_local_billitems_snapshot(payload=payload, forced_bill_id=forced_bill_id)
    _apply_local_inventory_reduction(payload=payload)


def enqueue_bill_create(current_user_id: str, bill_payload: Dict[str, Any]) -> Dict[str, str]:
    client_request_id = str(bill_payload.get("_client_request_id") or "").strip()
    queue_id = f"Q-{uuid.uuid4().hex[:12]}"

    with _queue_lock:
        queue = read_json_file(OFFLINE_BILL_QUEUE_FILE, [])
        forced_bill_id = bill_payload.get("_forced_bill_id") or _next_offline_invoice_id(queue)
        if client_request_id:
            existing = next(
                (
                    q
                    for q in queue
                    if str(q.get("client_request_id") or "").strip() == client_request_id
                ),
                None,
            )
            if existing:
                return {
                    "queue_id": existing.get("queue_id", queue_id),
                    "bill_id": existing.get("forced_bill_id", forced_bill_id),
                }
        item = {
            "queue_id": queue_id,
            "type": "create_bill",
            "user_id": current_user_id,
            "client_request_id": client_request_id or None,
            "forced_bill_id": forced_bill_id,
            "payload": {**bill_payload, "_forced_bill_id": forced_bill_id},
            "attempts": 0,
            "last_error": None,
            "created_at": _utc_now(),
            "updated_at": _utc_now(),
        }
        queue.append(item)
        write_json_file(OFFLINE_BILL_QUEUE_FILE, queue)
        _persist_local_offline_bill_snapshot(
            current_user_id=current_user_id,
            payload=item["payload"],
            forced_bill_id=forced_bill_id,
        )

    return {"queue_id": queue_id, "bill_id": forced_bill_id}


def get_queue_size() -> int:
    with _queue_lock:
        queue = read_json_file(OFFLINE_BILL_QUEUE_FILE, [])
        return len(queue)


def get_queue_status() -> Dict[str, Any]:
    with _queue_lock:
        queue = read_json_file(OFFLINE_BILL_QUEUE_FILE, [])
        if not isinstance(queue, list):
            queue = []
        return {
            "size": len(queue),
            "max_attempts": max((int(item.get("attempts", 0)) for item in queue), default=0),
            "oldest_created_at": min((item.get("created_at") for item in queue if item.get("created_at")), default=None),
            "recent_errors": [item.get("last_error") for item in queue if item.get("last_error")][-3:],
        }


def process_offline_bill_queue(app_logger=None, max_items: int = 20) -> Dict[str, int]:
    with _queue_lock:
        queue = read_json_file(OFFLINE_BILL_QUEUE_FILE, [])
        if not queue:
            return {"processed": 0, "succeeded": 0, "failed": 0, "remaining": 0}
        supabase = get_supabase_client()
        if not supabase or getattr(supabase, "is_offline_fallback", False):
            return {"processed": 0, "succeeded": 0, "failed": 0, "remaining": len(queue)}

        processed = 0
        succeeded = 0
        failed = 0
        remaining = []

        for item in queue:
            if processed >= max_items:
                remaining.append(item)
                continue

            processed += 1
            try:
                if item.get("type") != "create_bill":
                    raise RuntimeError(f"Unsupported queue item type: {item.get('type')}")

                create_bill_transaction(
                    current_user_id=item["user_id"],
                    data=item["payload"],
                    forced_bill_id=item.get("forced_bill_id"),
                )
                succeeded += 1
            except Exception as e:
                item["attempts"] = int(item.get("attempts", 0)) + 1
                item["last_error"] = str(e)
                item["updated_at"] = _utc_now()
                failed += 1

                if item["attempts"] < MAX_RETRIES:
                    remaining.append(item)
                elif app_logger:
                    app_logger.error(
                        f"Dropping offline queue item {item.get('queue_id')} after max retries. Error: {e}"
                    )

        write_json_file(OFFLINE_BILL_QUEUE_FILE, remaining)

    if app_logger and processed > 0:
        app_logger.info(
            f"Offline bill queue processed: processed={processed}, succeeded={succeeded}, failed={failed}, remaining={len(remaining)}"
        )

    return {
        "processed": processed,
        "succeeded": succeeded,
        "failed": failed,
        "remaining": len(remaining),
    }
