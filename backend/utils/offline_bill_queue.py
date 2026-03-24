import threading
import uuid
from datetime import datetime, timezone
from typing import Dict, Any
import re
from zoneinfo import ZoneInfo

from config.config import OFFLINE_BILL_QUEUE_FILE, BILLS_FILE
from helpers.utils import read_json_file, write_json_file
from services.billing_service import create_bill_transaction
from utils.connection_pool import get_supabase_client

_queue_lock = threading.Lock()
MAX_RETRIES = 100
INVOICE_ID_REGEX = re.compile(r"^INV-(\d{8})(\d{4})$")
IST_ZONE = ZoneInfo("Asia/Kolkata")


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
