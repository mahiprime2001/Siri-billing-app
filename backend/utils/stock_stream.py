import json
import queue
import threading
import time
from typing import Dict, List

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
