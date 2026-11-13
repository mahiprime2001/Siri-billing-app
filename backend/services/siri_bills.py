"""
Bills through siri-api, side by side with the offline queue: online and offline at once.

When the "bills_write" switch is ON for this store, a new sale goes to siri-api first. The offline queue keeps
working exactly as before and catches everything siri-api cannot take right now. The one rule that keeps a sale
from ever becoming two bills: ONE REQUEST ID PER SALE. The same id goes on the online attempt and, if the sale is
queued, on the queued copy. siri-api answers a repeat of an id with the bill it already made.

ONLINE ATTEMPT  attempt_online_bill()
    created                    -> the bill, same shape the screens already get (queued=False)
    a final "no" (400/403/409/423...) -> SiriBillRefused: the cashier sees the reason; nothing is queued
    token refused (401)        -> None: siri-api never saw the sale, so the old path runs
    no answer / server fault   -> "did it get through?" is asked once (by request id).
                                  Yes -> created.  Otherwise SiriBillUnsure: the sale is QUEUED with the same id and
                                  flagged `siri_unsure`. It is never sent down the old direct path: if siri-api DID
                                  save it, a second direct write would be a double bill.
REPLAY          replay_queued_bill()   (the offline queue sending a queued sale)
    sends it with the cashier's replay pass and the bill number the receipt already carries. siri-api's own verdict
    (`retryable`) decides retry-forever vs give-up: see SiriReplayError and queue_common.classify_error.

Nothing here talks to the database directly.
"""
import logging
import uuid
from typing import Any, Dict, Optional
from urllib.parse import quote

from utils.siri_api import get_client

logger = logging.getLogger("main")

BILL_TIMEOUT = 25.0       # a bill touches stock for every line: allow more than a read
LOOKUP_TIMEOUT = 5.0
REPLAY_TIMEOUT = 30.0


class SiriBillRefused(Exception):
    """siri-api understood the sale and said no (no stock, bad data, billing paused, not your store...).
    A final answer: show it, do not queue, do not retry."""

    def __init__(self, status: int, body: Dict[str, Any]):
        super().__init__((body or {}).get("message") or f"siri-api refused the bill ({status})")
        self.status, self.body = status, body or {}


class SiriBillUnsure(Exception):
    """We cannot tell whether siri-api saved the sale. It must be queued with the same request id."""


class SiriReplayError(Exception):
    """A queued sale could not be delivered. `siri_retryable` is siri-api's own verdict (or True for 'it did not
    answer'): True = keep retrying for ever, False = a final answer that counts toward giving up."""

    def __init__(self, message: str, retryable: bool):
        super().__init__(message)
        self.siri_retryable = retryable


def _min_serial_hint(data: Dict[str, Any]) -> int:
    """The highest bill serial waiting in this store's offline queue today, so siri-api never gives an online bill
    a number a queued offline bill already holds."""
    try:
        from utils.offline_bill_queue import (
            _get_store_code_from_local, _today_invoice_prefix, read_pending_offline_invoice_serials,
        )
        prefix = _today_invoice_prefix(_get_store_code_from_local(str(data.get("store_id") or "")))
        serials = [s for s in read_pending_offline_invoice_serials(prefix) if s]
        return max(serials) if serials else 0
    except Exception:  # noqa: BLE001 - a hint only
        return 0


def _after_created(data: Dict[str, Any], bill_id: str, snapshots) -> None:
    """The small local follow-ups a saved bill needs on this PC (all best effort, none may fail the sale)."""
    store_id = str(data.get("store_id") or "")
    try:
        if snapshots:
            from utils.bill_item_snapshot import replace_bill_item_snapshots
            replace_bill_item_snapshots(bill_id, snapshots)        # the tax/HSN detail the printed receipt uses
    except Exception as e:  # noqa: BLE001
        logger.warning("SIRI_API bill %s: could not save the receipt detail locally: %s", bill_id, e)
    try:
        product_ids = list(dict.fromkeys(str(i.get("product_id")) for i in (data.get("items") or []) if i.get("product_id")))
        if product_ids:
            from datetime import datetime, timezone
            from utils.stock_stream import publish
            publish({"type": "stock_update", "store_id": store_id, "product_ids": product_ids,
                     "ts": datetime.now(timezone.utc).isoformat()})
    except Exception as e:  # noqa: BLE001
        logger.warning("SIRI_API bill %s: could not announce the stock change: %s", bill_id, e)
    try:
        from utils.products_cache import invalidate_products_cache_for_store
        invalidate_products_cache_for_store(store_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("SIRI_API bill %s: could not refresh the product cache: %s", bill_id, e)


def _created(data: Dict[str, Any], body: Dict[str, Any], via: str) -> Dict[str, Any]:
    bill_id = body.get("bill_id") or (body.get("bill") or {}).get("id")
    _after_created(data, str(bill_id), body.get("item_snapshots"))
    return {
        "queued": False, "message": body.get("message") or "Bill created successfully", "bill_id": bill_id,
        "bill": body.get("bill"), "items_created": body.get("items_created", len(data.get("items") or [])),
        "total_amount": body.get("total_amount", data.get("total_amount")),
        "replacements_created": body.get("replacements_created", 0), "via": via,
        **({"idempotent_replay": True} if body.get("idempotent_replay") else {}),
    }


def _already_made(api, request_id: str) -> Optional[Dict[str, Any]]:
    """Ask siri-api whether this request id already made a bill. The bill's record, or None (no / cannot tell)."""
    resp = api.request("GET", f"/api/store/bills/by-request/{quote(request_id, safe='')}", timeout=LOOKUP_TIMEOUT)
    body = resp.json() if resp.error is None and resp.status == 200 else None
    return body if isinstance(body, dict) and body.get("found") else None


def attempt_online_bill(current_user_id: str, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Try to make the sale through siri-api. See the module docstring for the outcomes. `data` gets the sale's
    request id added (so the queue, if it comes to that, reuses it)."""
    api = get_client()
    try:
        if not api.enabled("bills_write") or current_user_id != api.session_user_id():
            return None
    except Exception:  # noqa: BLE001 - never let the switch machinery stop a sale
        return None

    request_id = str(data.get("_client_request_id") or "").strip()
    if not request_id:
        request_id = f"pc-{uuid.uuid4().hex}"
        data["_client_request_id"] = request_id
    payload = dict(data)
    hint = _min_serial_hint(data)
    if hint:
        payload["_min_serial"] = hint

    resp = api.request("POST", "/api/store/bills", json_body=payload, timeout=BILL_TIMEOUT)
    if resp.status in (200, 201) and resp.error is None:
        body = resp.json() if isinstance(resp.json(), dict) else {}
        logger.info("SIRI_API bill created bill=%s ms=%s", body.get("bill_id"), resp.elapsed_ms)
        return _created(data, body, "siri-api")
    if resp.status == 401:
        return None                                    # siri-api never saw the sale: the old path can make it
    if resp.error is None and 400 <= resp.status < 500:
        body = resp.json() if isinstance(resp.json(), dict) else {}
        logger.info("SIRI_API bill refused status=%s code=%s", resp.status, body.get("code"))
        raise SiriBillRefused(resp.status, body)

    # No answer, or a server fault: the sale may or may not have been saved.
    logger.warning("SIRI_API bill not confirmed (status=%s error=%s): checking by request id", resp.status, resp.error)
    found = _already_made(api, request_id)
    if found:
        logger.info("SIRI_API the sale had been saved: bill=%s", found.get("bill_id"))
        return _created(data, {"bill_id": found.get("bill_id"), "bill": found.get("bill"),
                               "message": "Bill already processed", "idempotent_replay": True}, "siri-api")
    raise SiriBillUnsure(resp.error or f"HTTP {resp.status}")


def replay_queued_bill(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Send one queued sale to siri-api with the cashier's replay pass.

    Returns {"bill_id", "idempotent"} when siri-api has the bill (made now, or already made); None when siri-api is
    not to be used for this sale (switch off, no replay pass for this cashier, or the pass was refused); raises
    SiriReplayError for everything else (carrying retry-forever or final)."""
    api = get_client()
    try:
        if not api.switch_on("bills_write"):
            return None
        payload = dict(item.get("payload") or {})
        store_id = str(payload.get("store_id") or "")
        user_id = item.get("user_id")
        if not api.replay_token(store_id, user_id):
            return None
    except Exception:  # noqa: BLE001
        return None

    forced = item.get("forced_bill_id") or payload.get("_forced_bill_id")
    if item.get("client_request_id"):
        payload["_client_request_id"] = item["client_request_id"]
    payload["forced_bill_id"] = forced
    resp = api.request("POST", "/api/store/replay/bills", json_body=payload, replay=True, store_id=store_id,
                       user_id=user_id, timeout=REPLAY_TIMEOUT)
    if resp.status in (200, 201) and resp.error is None:
        body = resp.json() if isinstance(resp.json(), dict) else {}
        made = body.get("bill_id")
        if made and forced and made != forced:
            # siri-api already had this sale under another number (its first, online attempt landed). The receipt the
            # customer holds shows `forced`. No second bill was made; worth a person's eye.
            from utils.queue_common import log_offline_event
            log_offline_event("bill_number_differs", queue="bills", bill_id=forced, server_bill_id=made,
                              store_id=store_id, queue_id=item.get("queue_id"))
        return {"bill_id": made or forced, "idempotent": bool(body.get("idempotent_replay"))}
    if resp.status == 401:
        return None                                    # the pass was refused (revoked): the old path, until a new login
    if resp.error is not None or resp.status >= 500:
        body = resp.json() if resp.error is None and isinstance(resp.json(), dict) else {}
        raise SiriReplayError(f"siri-api did not answer ({resp.error or resp.status}); connection problem, will retry",
                              retryable=body.get("retryable") is not False)
    body = resp.json() if isinstance(resp.json(), dict) else {}
    raise SiriReplayError(f"siri-api refused the queued bill ({resp.status}, {body.get('code')}): {body.get('message')}",
                          retryable=body.get("retryable") is True)
