import threading
import time
from typing import Dict, List, Optional

_LOCK = threading.Lock()
_CACHE: Dict[str, Dict] = {}
_DEFAULT_TTL_SECONDS = 300


def get_cloud_products_cache(cache_key: str, ttl_seconds: int = _DEFAULT_TTL_SECONDS) -> Optional[List[Dict]]:
    now_ts = time.time()
    with _LOCK:
        entry = _CACHE.get(cache_key)
        if not entry:
            return None
        if now_ts - float(entry.get("ts", 0)) > ttl_seconds:
            _CACHE.pop(cache_key, None)
            return None
        return entry.get("items", [])


def set_cloud_products_cache(cache_key: str, store_id: str, items: List[Dict]) -> None:
    with _LOCK:
        _CACHE[cache_key] = {
            "ts": time.time(),
            "store_id": str(store_id),
            "items": items,
        }


def invalidate_products_cache_for_store(store_id: Optional[str]) -> int:
    target = str(store_id or "").strip()
    if not target:
        return invalidate_all_products_cache()

    removed = 0
    with _LOCK:
        keys = [k for k, v in _CACHE.items() if str(v.get("store_id", "")) == target]
        for key in keys:
            _CACHE.pop(key, None)
            removed += 1
    return removed


def invalidate_all_products_cache() -> int:
    with _LOCK:
        count = len(_CACHE)
        _CACHE.clear()
        return count
