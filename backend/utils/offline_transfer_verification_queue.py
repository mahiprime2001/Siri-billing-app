import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict

from config.config import OFFLINE_TRANSFER_VERIFICATION_QUEUE_FILE
from helpers.utils import read_json_file, write_json_file
from utils.connection_pool import get_supabase_client

_queue_lock = threading.Lock()
MAX_RETRIES = 100


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def enqueue_transfer_verification_create(
    user_id: str,
    store_id: str,
    order_id: str,
    verification_data: Dict[str, Any],
) -> Dict[str, str]:
    session_id = verification_data.get("verification_session_id") or f"ver-{uuid.uuid4().hex[:16]}"
    queue_id = f"QTV-{uuid.uuid4().hex[:12]}"
    item = {
        "queue_id": queue_id,
        "type": "create_transfer_verification",
        "user_id": user_id,
        "store_id": store_id,
        "order_id": order_id,
        "verification_data": {**verification_data, "verification_session_id": session_id},
        "attempts": 0,
        "last_error": None,
        "created_at": _utc_now(),
        "updated_at": _utc_now(),
    }

    with _queue_lock:
        queue = read_json_file(OFFLINE_TRANSFER_VERIFICATION_QUEUE_FILE, [])
        queue.append(item)
        write_json_file(OFFLINE_TRANSFER_VERIFICATION_QUEUE_FILE, queue)

    return {"queue_id": queue_id, "verification_session_id": session_id}


def process_offline_transfer_verification_queue(app_logger=None, max_items: int = 20) -> Dict[str, int]:
    with _queue_lock:
        queue = read_json_file(OFFLINE_TRANSFER_VERIFICATION_QUEUE_FILE, [])
        if not queue:
            return {"processed": 0, "succeeded": 0, "failed": 0, "remaining": 0}

        supabase = get_supabase_client()
        if not supabase or getattr(supabase, "is_offline_fallback", False):
            return {"processed": 0, "succeeded": 0, "failed": 0, "remaining": len(queue)}

        from routes.store_routes import _apply_transfer_order_verification

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
                result, status_code = _apply_transfer_order_verification(
                    supabase=supabase,
                    current_user_id=item.get("user_id"),
                    store_id=item.get("store_id"),
                    order_id=item.get("order_id"),
                    data=item.get("verification_data") or {},
                )

                if status_code < 300 or result.get("status") == "duplicate_ignored":
                    succeeded += 1
                else:
                    raise RuntimeError(result.get("message") or f"Verification failed with status {status_code}")
            except Exception as e:
                item["attempts"] = int(item.get("attempts", 0)) + 1
                item["last_error"] = str(e)
                item["updated_at"] = _utc_now()
                failed += 1

                if item["attempts"] < MAX_RETRIES:
                    remaining.append(item)
                elif app_logger:
                    app_logger.error(
                        f"Dropping transfer-verification queue item {item.get('queue_id')} after max retries. Error: {e}"
                    )

        write_json_file(OFFLINE_TRANSFER_VERIFICATION_QUEUE_FILE, remaining)

    if app_logger and processed > 0:
        app_logger.info(
            f"Offline transfer-verification queue processed: processed={processed}, succeeded={succeeded}, failed={failed}, remaining={len(remaining)}"
        )

    return {
        "processed": processed,
        "succeeded": succeeded,
        "failed": failed,
        "remaining": len(remaining),
    }


def get_queue_status() -> Dict[str, Any]:
    with _queue_lock:
        queue = read_json_file(OFFLINE_TRANSFER_VERIFICATION_QUEUE_FILE, [])
        if not isinstance(queue, list):
            queue = []
        return {
            "size": len(queue),
            "max_attempts": max((int(item.get("attempts", 0)) for item in queue), default=0),
            "oldest_created_at": min((item.get("created_at") for item in queue if item.get("created_at")), default=None),
            "recent_errors": [item.get("last_error") for item in queue if item.get("last_error")][-3:],
        }
