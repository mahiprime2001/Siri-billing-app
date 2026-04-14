import json
import queue
import threading
import time
from typing import Dict, List
from utils.products_cache import invalidate_products_cache_for_store

_subscribers: List[queue.Queue] = []
_lock = threading.Lock()


def subscribe() -> queue.Queue:
    q: queue.Queue = queue.Queue(maxsize=100)
    with _lock:
        _subscribers.append(q)
    return q


def unsubscribe(q: queue.Queue) -> None:
    with _lock:
        if q in _subscribers:
            _subscribers.remove(q)


def publish(event: Dict) -> None:
    if isinstance(event, dict) and event.get("type") == "stock_update":
        invalidate_products_cache_for_store(event.get("store_id"))
    payload = json.dumps(event)
    with _lock:
        for q in list(_subscribers):
            try:
                q.put_nowait(payload)
            except queue.Full:
                # Drop if client is slow to consume
                continue


def keepalive_payload() -> str:
    return json.dumps({"type": "keepalive", "ts": int(time.time())})
