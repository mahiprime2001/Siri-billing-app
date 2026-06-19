import threading
import uuid
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Dict, Any
import re
from zoneinfo import ZoneInfo

from config.config import OFFLINE_BILL_QUEUE_FILE, BILLS_FILE, STOREINVENTORY_FILE, PRODUCTS_FILE, STORES_FILE, JSON_DIR
from helpers.utils import read_json_file, write_json_file, read_json_file_strict, QueueReadError
from services.billing_service import create_bill_transaction
from utils.connection_pool import get_supabase_client
from utils.queue_common import (
    classify_error,
    quarantine_item,
    log_offline_event,
    MAX_PERMANENT_ATTEMPTS,
)

_queue_lock = threading.Lock()
# How many bills to replay concurrently once connectivity returns. Replay is
# idempotent (create_bill_transaction resolves by forced_bill_id), so parallel
# draining is safe and clears a post-outage backlog quickly.
REPLAY_WORKERS = 4
INVOICE_ID_REGEX = re.compile(r"^INV-([A-Z0-9]+)-(\d{8})(\d{4})$")
IST_ZONE = ZoneInfo("Asia/Kolkata")
BILL_ITEMS_FILE = os.path.join(JSON_DIR, "billitems.json")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_store_code_from_local(store_id: str) -> str:
    """Look up the store code from the local stores JSON cache."""
    if not store_id:
        return "STR"
    stores = read_json_file(STORES_FILE, [])
    if isinstance(stores, list):
        for store in stores:
            if str(store.get("id") or "") == str(store_id):
                code = str(store.get("storecode") or "").strip().upper()
                if code:
                    return code
    return "STR"


def _today_invoice_prefix(store_code: str = "STR") -> str:
    return f"INV-{store_code}-{datetime.now(IST_ZONE).strftime('%d%m%Y')}"


def _extract_serial(invoice_id: str, prefix: str) -> int:
    if not invoice_id or not invoice_id.startswith(prefix):
        return 0
    match = INVOICE_ID_REGEX.match(str(invoice_id))
    if not match:
        return 0
    try:
        return int(match.group(3))
    except (TypeError, ValueError):
        return 0


def _next_offline_invoice_id(existing_queue, store_id: str = "") -> str:
    store_code = _get_store_code_from_local(store_id)
    prefix = _today_invoice_prefix(store_code)
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
        # Strict read: if the queue file is corrupt it is backed up and this
        # raises, instead of returning [] and letting us overwrite (erase) the
        # whole queue with just this one item.
        try:
            queue = read_json_file_strict(OFFLINE_BILL_QUEUE_FILE)
        except QueueReadError as e:
            raise RuntimeError(f"Offline bill queue unavailable: {e}") from e
        forced_bill_id = bill_payload.get("_forced_bill_id") or _next_offline_invoice_id(queue, str(bill_payload.get("store_id") or ""))
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
        # Fail loudly if the durable write did not succeed, so the caller never
        # reports "queued" for a bill that was not actually persisted.
        if not write_json_file(OFFLINE_BILL_QUEUE_FILE, queue):
            raise RuntimeError("Failed to persist offline bill queue to disk")
        _persist_local_offline_bill_snapshot(
            current_user_id=current_user_id,
            payload=item["payload"],
            forced_bill_id=forced_bill_id,
        )

    return {"queue_id": queue_id, "bill_id": forced_bill_id}


def read_pending_offline_invoice_serials(prefix: str) -> list:
    """Return serial numbers of pending offline-queued bills matching the given invoice prefix.

    Acquires the queue lock so callers don't observe a torn write during enqueue.
    """
    if not prefix:
        return []
    with _queue_lock:
        queue = read_json_file(OFFLINE_BILL_QUEUE_FILE, [])
    if not isinstance(queue, list):
        return []
    serials = []
    for queued in queue:
        if not isinstance(queued, dict):
            continue
        serials.append(_extract_serial(str(queued.get("forced_bill_id") or ""), prefix))
        payload = queued.get("payload") or {}
        if isinstance(payload, dict):
            serials.append(_extract_serial(str(payload.get("_forced_bill_id") or ""), prefix))
    return serials


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


def _replay_one(item: Dict[str, Any], app=None):
    """Replay a single queued bill. Returns (status, item, reason).

    status is one of: "success" | "retry" | "poison". A transient (network)
    failure always retries; a permanent failure retries a few times then is
    flagged for quarantine. Runs inside the Flask app context so local-file
    writes inside create_bill_transaction have access to current_app.
    """
    def _run():
        try:
            if item.get("type") != "create_bill":
                raise RuntimeError(f"Unsupported queue item type: {item.get('type')}")
            create_bill_transaction(
                current_user_id=item["user_id"],
                data=item["payload"],
                forced_bill_id=item.get("forced_bill_id"),
            )
            return ("success", item, None)
        except Exception as e:
            updated = dict(item)
            updated["attempts"] = int(item.get("attempts", 0)) + 1
            updated["last_error"] = str(e)
            updated["last_error_class"] = classify_error(e)
            updated["updated_at"] = _utc_now()
            if (
                updated["last_error_class"] == "permanent"
                and updated["attempts"] >= MAX_PERMANENT_ATTEMPTS
            ):
                return ("poison", updated, str(e))
            return ("retry", updated, str(e))

    if app is not None:
        with app.app_context():
            return _run()
    return _run()


def process_offline_bill_queue(app=None, app_logger=None, max_items: int = 25) -> Dict[str, int]:
    """Drain the offline bill queue without ever blocking new offline saves.

    Phase 1 (short lock): claim a batch — no network here.
    Phase 2 (no lock): replay the batch in parallel; the cashier can still
        enqueue new bills meanwhile.
    Phase 3 (short lock): re-read the queue (to keep bills enqueued mid-drain)
        and write back only the items we handled.
    Phase 4: preserve any poison items in the dead-letter store and log them.
    """
    logger = app_logger or (getattr(app, "logger", None) if app else None)

    # Phase 1 — claim a batch under a brief lock (no network while held).
    with _queue_lock:
        queue = read_json_file(OFFLINE_BILL_QUEUE_FILE, [])
        if not isinstance(queue, list) or not queue:
            return {"processed": 0, "succeeded": 0, "failed": 0, "quarantined": 0, "remaining": 0}
        supabase = get_supabase_client()
        if not supabase or getattr(supabase, "is_offline_fallback", False):
            return {"processed": 0, "succeeded": 0, "failed": 0, "quarantined": 0, "remaining": len(queue)}
        batch = list(queue[:max_items])

    # Phase 2 — replay lock-free, in parallel (idempotent, so safe).
    if len(batch) == 1:
        results = [_replay_one(batch[0], app=app)]
    else:
        with ThreadPoolExecutor(max_workers=min(REPLAY_WORKERS, len(batch))) as pool:
            results = list(pool.map(lambda it: _replay_one(it, app=app), batch))

    succeeded_ids = set()
    updated_by_id: Dict[str, Any] = {}
    poisoned = []
    for status, item, _reason in results:
        qid = item.get("queue_id")
        if status == "success":
            succeeded_ids.add(qid)
        elif status == "poison":
            poisoned.append(item)
        else:  # retry
            updated_by_id[qid] = item
    poison_ids = {p.get("queue_id") for p in poisoned}

    # Phase 3 — write back under a brief lock. Re-read first so any bills the
    # cashier enqueued DURING phase 2 are preserved (we touch only our items).
    with _queue_lock:
        current = read_json_file(OFFLINE_BILL_QUEUE_FILE, [])
        if not isinstance(current, list):
            current = []
        new_queue = []
        for it in current:
            qid = it.get("queue_id")
            if qid in succeeded_ids or qid in poison_ids:
                continue
            new_queue.append(updated_by_id.get(qid, it))
        write_json_file(OFFLINE_BILL_QUEUE_FILE, new_queue)

    # Phase 4 — preserve poison (never dropped) and record it in diagnostics.
    for p in poisoned:
        quarantine_item(OFFLINE_BILL_QUEUE_FILE, p, p.get("last_error"))
        log_offline_event(
            "quarantined",
            queue="bills",
            bill_id=p.get("forced_bill_id"),
            queue_id=p.get("queue_id"),
            attempts=p.get("attempts"),
            reason=p.get("last_error"),
        )
        if logger:
            logger.error(
                f"Quarantined offline bill {p.get('forced_bill_id')} after "
                f"{p.get('attempts')} permanent failures: {p.get('last_error')}"
            )

    processed = len(results)
    succeeded = len(succeeded_ids)
    quarantined = len(poisoned)
    retried = len(updated_by_id)
    remaining = len(new_queue)

    if processed > 0:
        if logger:
            logger.info(
                f"Offline bill queue: processed={processed}, succeeded={succeeded}, "
                f"retry={retried}, quarantined={quarantined}, remaining={remaining}"
            )
        if succeeded or quarantined:
            log_offline_event(
                "replay_batch",
                queue="bills",
                processed=processed,
                succeeded=succeeded,
                retried=retried,
                quarantined=quarantined,
                remaining=remaining,
            )

    return {
        "processed": processed,
        "succeeded": succeeded,
        "failed": retried,
        "quarantined": quarantined,
        "remaining": remaining,
    }
