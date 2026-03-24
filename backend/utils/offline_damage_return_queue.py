import threading
import uuid
from datetime import datetime, timezone
from typing import Dict, Any

from config.config import OFFLINE_DAMAGE_RETURN_QUEUE_FILE
from helpers.utils import read_json_file, write_json_file
from utils.connection_pool import get_supabase_client
from data_access.data_access import update_both_inventory_and_product_stock

_queue_lock = threading.Lock()
MAX_RETRIES = 100


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def enqueue_damage_return_create(user_id: str, payload: Dict[str, Any]) -> Dict[str, str]:
    row_id = payload.get("id") or f"SDR-{uuid.uuid4().hex[:12].upper()}"
    queue_id = f"QDR-{uuid.uuid4().hex[:12]}"
    item = {
        "queue_id": queue_id,
        "type": "create_store_damage_return",
        "user_id": user_id,
        "payload": {**payload, "id": row_id},
        "attempts": 0,
        "stock_applied": False,
        "event_inserted": False,
        "last_error": None,
        "created_at": _utc_now(),
        "updated_at": _utc_now(),
    }

    with _queue_lock:
        queue = read_json_file(OFFLINE_DAMAGE_RETURN_QUEUE_FILE, [])
        queue.append(item)
        write_json_file(OFFLINE_DAMAGE_RETURN_QUEUE_FILE, queue)

    return {"queue_id": queue_id, "row_id": row_id}


def process_offline_damage_return_queue(app_logger=None, max_items: int = 20) -> Dict[str, int]:
    with _queue_lock:
        queue = read_json_file(OFFLINE_DAMAGE_RETURN_QUEUE_FILE, [])
        if not queue:
            return {"processed": 0, "succeeded": 0, "failed": 0, "remaining": 0}

        supabase = get_supabase_client()
        if not supabase:
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
            row_id = payload.get("id")

            try:
                supabase.table("store_damage_returns").upsert(payload).execute()

                if not item.get("stock_applied"):
                    ok = update_both_inventory_and_product_stock(
                        store_id=payload.get("store_id"),
                        product_id=payload.get("product_id"),
                        quantity_sold=int(payload.get("quantity") or 0),
                    )
                    if not ok:
                        raise RuntimeError("Failed to apply stock update in Supabase")
                    item["stock_applied"] = True

                if not item.get("event_inserted"):
                    supabase.table("damaged_inventory_events").insert(
                        {
                            "id": f"DMG-{uuid.uuid4().hex[:12].upper()}",
                            "store_id": payload.get("store_id"),
                            "product_id": payload.get("product_id"),
                            "quantity": int(payload.get("quantity") or 0),
                            "source_type": "store_damage_return",
                            "source_id": row_id,
                            "reason": payload.get("reason") or "Damaged in store",
                            "status": "reported",
                            "reported_by": item.get("user_id"),
                            "created_at": _utc_now(),
                            "updated_at": _utc_now(),
                        }
                    ).execute()
                    item["event_inserted"] = True

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
                        f"Dropping offline damage-return queue item {item.get('queue_id')} after max retries. Error: {e}"
                    )

        write_json_file(OFFLINE_DAMAGE_RETURN_QUEUE_FILE, remaining)

    if app_logger and processed > 0:
        app_logger.info(
            f"Offline damage-return queue processed: processed={processed}, succeeded={succeeded}, failed={failed}, remaining={len(remaining)}"
        )

    return {
        "processed": processed,
        "succeeded": succeeded,
        "failed": failed,
        "remaining": len(remaining),
    }


def get_queue_status() -> Dict[str, Any]:
    with _queue_lock:
        queue = read_json_file(OFFLINE_DAMAGE_RETURN_QUEUE_FILE, [])
        if not isinstance(queue, list):
            queue = []
        return {
            "size": len(queue),
            "max_attempts": max((int(item.get("attempts", 0)) for item in queue), default=0),
            "oldest_created_at": min((item.get("created_at") for item in queue if item.get("created_at")), default=None),
            "recent_errors": [item.get("last_error") for item in queue if item.get("last_error")][-3:],
        }
