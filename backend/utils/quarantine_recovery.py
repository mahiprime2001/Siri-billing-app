"""
Self-healing for queued bills that were given up on ONLY because the internet was down.

Before 22 July 2026 an offline bill whose replay failed with "Supabase client unavailable" was
misread as a data problem; after a few tries it was moved to the poison file
(offline_bill_queue.poison.json) instead of being retried. The cause is fixed, but bills that were
already put aside stayed there -- they never reached the database.

Every minute (from the bill-queue loop) this looks at the poison file and, for each bill that was
given up for a connection reason:
  * if the bill is already in the database (same bill number, same amount) -> it is simply cleared
    from the poison file (it had been delivered another way);
  * otherwise it goes back into the live queue with its counters reset. From there the normal replay
    does the work, with all its protections: the original bill number, the original date, no double
    sending, stock check. If it fails again for a REAL reason it returns to the poison file with that
    reason (never deleted, never retried forever).

Bills put aside for genuine data problems are left alone. Nothing here deletes a bill.
"""
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from config.config import OFFLINE_BILL_QUEUE_FILE
from helpers.utils import read_json_file, write_json_file
from services.billing_service import _fetch_existing_bill_by_id, _payload_matches_existing_bill
from utils.connection_pool import get_supabase_client
from utils.offline_bill_queue import _queue_lock
from utils.queue_common import classify_error, log_offline_event, poison_file_for

# At most this many times is one bill taken back out of the poison file, so a bill that keeps failing
# for a reason that merely LOOKS like a connection problem can never loop forever.
MAX_RECOVERIES_PER_BILL = 2

# The wording of the old misclassified error (before the dedicated transient error existed).
_OLD_CONNECTION_WORDING = ("supabase client unavailable",)

_QUARANTINE_FIELDS = ("quarantined_at", "quarantine_reason")


def _reason(item: Dict[str, Any]) -> str:
    return str(item.get("quarantine_reason") or item.get("last_error") or "")


def is_connection_giveup(item: Dict[str, Any]) -> bool:
    """True if this poisoned bill was given up on because of connectivity, not bad data."""
    if not isinstance(item, dict) or item.get("type") != "create_bill":
        return False
    if int(item.get("recovery_count") or 0) >= MAX_RECOVERIES_PER_BILL:
        return False
    text = _reason(item).lower()
    if any(w in text for w in _OLD_CONNECTION_WORDING):
        return True
    return classify_error(text) == "transient"


def _fresh_copy(item: Dict[str, Any]) -> Dict[str, Any]:
    """The poisoned item as a clean live-queue item (counters reset, original identity kept)."""
    out = {k: v for k, v in item.items() if k not in _QUARANTINE_FIELDS}
    out["attempts"] = 0
    out["last_error"] = None
    out["last_error_class"] = None
    out["consecutive_permanent_failures"] = 0
    out["recovery_count"] = int(item.get("recovery_count") or 0) + 1
    out["recovered_from_quarantine_at"] = datetime.now(timezone.utc).isoformat()
    # Keep the ORIGINAL sale time: without an explicit time the bill would be dated "now".
    payload = dict(out.get("payload") or {})
    if not (payload.get("timestamp") or payload.get("created_at")) and item.get("created_at"):
        payload["timestamp"] = item["created_at"]
    out["payload"] = payload
    return out


def recover_quarantined_bills(app_logger=None, supabase=None) -> Dict[str, int]:
    """One pass. Cheap when there is nothing to do (no network is used unless a bill needs checking)."""
    result = {"checked": 0, "already_delivered": 0, "requeued": 0, "left_alone": 0, "waiting": 0}
    poison_file = poison_file_for(OFFLINE_BILL_QUEUE_FILE)

    with _queue_lock:
        poison = read_json_file(poison_file, [])
    if not isinstance(poison, list) or not poison:
        return result

    eligible = [p for p in poison if is_connection_giveup(p)]
    result["left_alone"] = len(poison) - len(eligible)
    if not eligible:
        return result

    client = supabase or get_supabase_client()
    if not client or getattr(client, "is_offline_fallback", False):
        result["waiting"] = len(eligible)  # still offline: try again on the next pass
        return result

    delivered_ids: List[Optional[str]] = []
    to_requeue: List[Dict[str, Any]] = []
    for item in eligible:
        result["checked"] += 1
        bill_id = str(item.get("forced_bill_id") or (item.get("payload") or {}).get("_forced_bill_id") or "")
        if not bill_id:
            result["left_alone"] += 1
            continue
        try:
            existing = _fetch_existing_bill_by_id(client, bill_id)
        except Exception:
            existing = None
        if existing and _payload_matches_existing_bill(existing, item.get("payload") or {}, item.get("user_id")):
            delivered_ids.append(item.get("queue_id"))
            result["already_delivered"] += 1
            log_offline_event("quarantine_already_delivered", queue="bills", bill_id=bill_id, queue_id=item.get("queue_id"))
            continue
        to_requeue.append(item)

    if not delivered_ids and not to_requeue:
        return result

    handled = set(delivered_ids) | {i.get("queue_id") for i in to_requeue}
    added: List[Dict[str, Any]] = []
    with _queue_lock:
        live = read_json_file(OFFLINE_BILL_QUEUE_FILE, [])
        if not isinstance(live, list):
            live = []
        live_ids = {q.get("queue_id") for q in live} | {str(q.get("forced_bill_id") or "") for q in live}
        for item in to_requeue:
            if item.get("queue_id") in live_ids or str(item.get("forced_bill_id") or "") in live_ids:
                continue  # already back in the queue (an earlier pass was interrupted): never duplicate
            added.append(_fresh_copy(item))
        # Live queue FIRST, poison second: if we are cut off in between, the bill exists in both places,
        # which is harmless (replay is idempotent) and the next pass tidies it up.
        if added and not write_json_file(OFFLINE_BILL_QUEUE_FILE, live + added):
            return result
        current_poison = read_json_file(poison_file, [])
        if not isinstance(current_poison, list):
            current_poison = []
        write_json_file(poison_file, [p for p in current_poison if p.get("queue_id") not in handled])

    for item in added:
        result["requeued"] += 1
        log_offline_event("quarantine_requeued", queue="bills", bill_id=item.get("forced_bill_id"),
                          queue_id=item.get("queue_id"), recovery_count=item.get("recovery_count"))
        if app_logger:
            app_logger.info(f"Recovered given-up bill {item.get('forced_bill_id')}: back in the offline queue.")
    return result
