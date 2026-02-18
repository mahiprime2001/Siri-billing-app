from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Optional, Dict, Any

_CACHE: Dict[str, Dict[str, Any]] = {}
_LOCK = Lock()
_TTL_SECONDS = 10 * 60  # 10 minutes


def set_discount_approval(user_id: str, approved_by: str) -> None:
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=_TTL_SECONDS)
    with _LOCK:
        _CACHE[user_id] = {
            "approved_by": approved_by,
            "expires_at": expires_at,
        }


def pop_discount_approval(user_id: str) -> Optional[Dict[str, Any]]:
    now = datetime.now(timezone.utc)
    with _LOCK:
        payload = _CACHE.get(user_id)
        if not payload:
            return None
        if payload["expires_at"] < now:
            _CACHE.pop(user_id, None)
            return None
        _CACHE.pop(user_id, None)
        return payload
