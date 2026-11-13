from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Optional, Dict, Any

_CACHE: Dict[str, Dict[str, Any]] = {}
_LOCK = Lock()
_TTL_SECONDS = 10 * 60  # 10 minutes


def set_discount_approval(user_id: str, approved_by: str, token: Optional[str] = None) -> None:
    """Remember that a manager approved a discount for this cashier's next bill. `token` is siri-api's signed proof
    of that approval (sent with the bill so siri-api can tell it is genuine); the old path ignores it."""
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=_TTL_SECONDS)
    with _LOCK:
        _CACHE[user_id] = {
            "approved_by": approved_by,
            "expires_at": expires_at,
            "token": token,
        }


def remember_deferred_approval(status: int, body) -> None:
    """After siri-api accepted a manager's code for a discount not yet on a bill: keep the approval (and its signed
    token) for this cashier's next bill, exactly where the old path keeps it. Called inside the request."""
    from flask_jwt_extended import get_jwt_identity
    if isinstance(body, dict) and body.get("deferred") and body.get("approval_token"):
        set_discount_approval(get_jwt_identity(), body.get("approved_by"), body.get("approval_token"))


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
