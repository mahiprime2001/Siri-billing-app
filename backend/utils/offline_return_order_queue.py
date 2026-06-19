"""
Offline queue for store -> admin RETURN ORDERS (returns + return_products).

A return order is created at the store and addressed to the admin. No stock
moves at creation time (stock leaves the store only when the admin verifies
receipt), so this queue just needs to durably insert the `returns` header and
its `return_products` lines into Supabase when connectivity returns.
"""
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict

from config.config import OFFLINE_RETURN_ORDER_QUEUE_FILE
from helpers.utils import read_json_file, write_json_file
from utils.connection_pool import get_supabase_client
from utils.queue_common import register_failure, quarantine_item, log_offline_event

_queue_lock = threading.Lock()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def enqueue_return_order_create(user_id: str, payload: Dict[str, Any]) -> Dict[str, str]:
    """Enqueue a whole return ORDER. payload = {header, lines}."""
    header = payload.get("header") or {}
    return_id = header.get("return_id") or f"RET-{uuid.uuid4().hex[:12].upper()}"
    queue_id = f"QRO-{uuid.uuid4().hex[:12]}"
    item = {
        "queue_id": queue_id,
        "type": "create_return_order",
        "user_id": user_id,
        "payload": payload,
        "attempts": 0,
        "header_inserted": False,
        "lines_inserted": False,
        "last_error": None,
        "created_at": _utc_now(),
        "updated_at": _utc_now(),
    }

    with _queue_lock:
        queue = read_json_file(OFFLINE_RETURN_ORDER_QUEUE_FILE, [])
        queue.append(item)
        write_json_file(OFFLINE_RETURN_ORDER_QUEUE_FILE, queue)

    return {"queue_id": queue_id, "return_id": return_id}


def process_offline_return_order_queue(app_logger=None, max_items: int = 20) -> Dict[str, int]:
    with _queue_lock:
        queue = read_json_file(OFFLINE_RETURN_ORDER_QUEUE_FILE, [])
        if not queue:
            return {"processed": 0, "succeeded": 0, "failed": 0, "remaining": 0}

        supabase = get_supabase_client()
        # Only sync against the real cloud client (the offline fallback is truthy).
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
            payload = item.get("payload") or {}
            header = payload.get("header") or {}
            lines = payload.get("lines") or []
            return_id = header.get("return_id")

            try:
                # `returns` has no unique constraint on return_id, so check-then-
                # insert keeps this idempotent on retries (return_products is keyed
                # by its own primary key, so a plain upsert is safe there).
                if not item.get("header_inserted"):
                    existing = (
                        supabase.table("returns")
                        .select("return_id")
                        .eq("return_id", return_id)
                        .limit(1)
                        .execute()
                    )
                    if not (existing.data or []):
                        supabase.table("returns").insert(header).execute()
                    item["header_inserted"] = True

                if not item.get("lines_inserted") and lines:
                    supabase.table("return_products").upsert(lines).execute()
                    item["lines_inserted"] = True

                succeeded += 1
            except Exception as e:
                failed += 1
                if register_failure(item, e) == "poison":
                    quarantine_item(OFFLINE_RETURN_ORDER_QUEUE_FILE, item, item["last_error"])
                    log_offline_event(
                        "quarantined",
                        queue="return_order",
                        queue_id=item.get("queue_id"),
                        return_id=return_id,
                        attempts=item.get("attempts"),
                        reason=item.get("last_error"),
                    )
                    if app_logger:
                        app_logger.error(
                            f"Quarantined offline return-order {item.get('queue_id')} after "
                            f"{item.get('attempts')} permanent failures. Error: {e}"
                        )
                else:
                    remaining.append(item)

        write_json_file(OFFLINE_RETURN_ORDER_QUEUE_FILE, remaining)

    if app_logger and processed > 0:
        app_logger.info(
            f"Offline return-order queue processed: processed={processed}, succeeded={succeeded}, failed={failed}, remaining={len(remaining)}"
        )

    return {
        "processed": processed,
        "succeeded": succeeded,
        "failed": failed,
        "remaining": len(remaining),
    }
