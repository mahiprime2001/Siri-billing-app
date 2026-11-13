"""
The other offline-capable writes through siri-api: damaged returns, return orders, transfer verifications.
Same idea as services/siri_bills.py (bills), simpler because each of these already has a stable key of its own:

    damaged return      the row id            (SDR-...)             -> sent as _client_request_id
    return order        the return id         (RET-...)             -> sent as _client_request_id
    transfer verify     verification_session_id                     -> sent as it is

A repeat of the same key is answered by siri-api with what it already made, so a sale-like action is never done twice
whether it goes online now, is queued after a lost answer, or is replayed later.

ONLINE (attempt_post)   an answer -> returned; a final "no" -> SiriBillRefused (shown to the cashier, nothing queued);
                        401 or "never left this PC" -> None (the old path runs, which itself queues when offline);
                        a lost answer -> SiriBillUnsure: the caller queues it with the SAME key and flags it
                        `siri_unsure`, so it is only ever delivered through siri-api, never the old direct path.
QUEUE (deliver_queued)  True = siri-api delivered it; False = use the old direct path; raises SiriReplayError when
                        it must be retried (retry for ever) or is a final answer (counts toward giving up).
"""
import logging
from typing import Any, Dict, Optional

from services.siri_bills import BILL_TIMEOUT, REPLAY_TIMEOUT, SiriBillRefused, SiriBillUnsure, SiriReplayError
from utils.siri_api import get_client

logger = logging.getLogger("main")

# queue kind -> the switch group that governs it
GROUP = {"damage_return": "returns", "return_order": "returns", "transfer": "transfers"}


# ---------------------------------------------------------------- request builders (from what the app already holds)

def damage_return_request(row: Dict[str, Any]) -> Dict[str, Any]:
    """One locally built damaged-return row -> the request siri-api takes. The row id is the request id."""
    return {
        "selectedItems": [{"productId": row.get("product_id"), "quantity": row.get("quantity"), "note": row.get("notes") or ""}],
        "reason": row.get("reason") or "", "reasonType": row.get("reason_type"),
        "damageOrigin": row.get("damage_origin") or "store", "_client_request_id": row.get("id"),
    }


def return_order_request(header: Dict[str, Any], lines: list) -> Dict[str, Any]:
    """A locally built return order (header + lines) -> the request siri-api takes. The return id is the request id."""
    return {
        "items": [{"productId": ln.get("product_id"), "quantity": ln.get("quantity"),
                   "reasonType": ln.get("reason_type") or "other", "reason": ln.get("reason") or "",
                   "note": ln.get("notes") or ""} for ln in (lines or [])],
        "note": header.get("message") or "", "_client_request_id": header.get("return_id"),
    }


# ---------------------------------------------------------------- online

def attempt_post(group: str, user_id: str, path: str, body: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Send one request through siri-api. See the module docstring for the outcomes."""
    api = get_client()
    try:
        if not api.enabled(group) or user_id != api.session_user_id():
            return None
    except Exception:  # noqa: BLE001 - never let the switch machinery stop the work
        return None
    resp = api.request("POST", path, json_body=body, timeout=BILL_TIMEOUT)
    if resp.status in (200, 201) and resp.error is None:
        answer = resp.json()
        return answer if isinstance(answer, dict) else {}
    if resp.status == 401 or resp.not_sent:
        return None                                   # siri-api never did anything: the old path can
    if resp.error is None and 400 <= resp.status < 500:
        answer = resp.json()
        raise SiriBillRefused(resp.status, answer if isinstance(answer, dict) else {})
    logger.warning("SIRI_API %s not confirmed (status=%s error=%s)", path, resp.status, resp.error)
    raise SiriBillUnsure(resp.error or f"HTTP {resp.status}")


# ---------------------------------------------------------------- the queues

def switch_on(kind: str) -> bool:
    """Should the queue for this kind keep running even if the direct database path is down?"""
    try:
        return get_client().switch_on(GROUP[kind])
    except Exception:  # noqa: BLE001
        return False


def _replay(kind: str, item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Send one queued item with its cashier's replay pass. None = not for siri-api (switch off / no pass / pass refused)."""
    api = get_client()
    user_id = item.get("user_id")
    if kind == "damage_return":
        payload = item.get("payload") or {}
        store_id, path, body = str(payload.get("store_id") or ""), "/api/store/replay/damage-returns", damage_return_request(payload)
    elif kind == "return_order":
        payload = item.get("payload") or {}
        header = payload.get("header") or {}
        store_id, path = str(header.get("store_id") or ""), "/api/store/replay/return-orders"
        body = return_order_request(header, payload.get("lines") or [])
    elif kind == "transfer":
        store_id = str(item.get("store_id") or "")
        path = f"/api/store/replay/transfer-orders/{item.get('order_id')}/verify"
        body = item.get("verification_data") or {}
    else:
        return None
    try:
        if not api.switch_on(GROUP[kind]) or not api.replay_token(store_id, user_id):
            return None
    except Exception:  # noqa: BLE001
        return None

    resp = api.request("POST", path, json_body=body, replay=True, store_id=store_id, user_id=user_id, timeout=REPLAY_TIMEOUT)
    if resp.status in (200, 201) and resp.error is None:
        answer = resp.json()
        return answer if isinstance(answer, dict) else {}
    if resp.status == 401:
        return None
    answer = resp.json() if resp.error is None and isinstance(resp.json(), dict) else {}
    if resp.error is not None or resp.status >= 500:
        raise SiriReplayError(f"siri-api did not answer ({resp.error or resp.status}); connection problem, will retry",
                              retryable=answer.get("retryable") is not False)
    raise SiriReplayError(f"siri-api refused the queued {kind} ({resp.status}, {answer.get('code')}): {answer.get('message')}",
                          retryable=answer.get("retryable") is True)


def deliver_queued(kind: str, item: Dict[str, Any]) -> bool:
    """True when siri-api delivered this queued item. False when the old direct path should deliver it. Raises
    SiriReplayError when it must wait (retry for ever) or is a final answer (counts toward giving up)."""
    failure: Optional[SiriReplayError] = None
    try:
        if _replay(kind, item) is not None:
            return True
    except SiriReplayError as e:
        failure = e
    except Exception as e:  # noqa: BLE001 - a bug in the siri path must never lose a queued item
        failure = SiriReplayError(f"siri-api path failed unexpectedly: {e}", retryable=True)
    if failure is not None and failure.siri_retryable is False:
        raise failure                                   # a final answer: the old path would only repeat it
    if item.get("siri_unsure"):
        # An online attempt for this very item may have been saved by siri-api: only siri-api (which knows the key)
        # may deliver it. Wait for it, never do the work twice.
        raise failure or SiriReplayError("waiting for siri-api to confirm this item", retryable=True)
    return False
