"""
Shared infrastructure for the offline queues.

Three concerns live here so every queue (bills, damage-returns, return-orders,
transfer-verifications) behaves identically:

1. classify_error()  — decide whether a failure is TRANSIENT (a connectivity
   problem worth retrying forever) or PERMANENT (a data/server problem that will
   never fix itself on its own and must be quarantined).

2. quarantine_item() — move a permanently-failing item to a per-queue "poison"
   file. NOTHING is ever deleted: the full payload, every error it hit, the
   attempt count and timestamps are preserved so it can be inspected, revived,
   or exported later.

3. log_offline_event() — append a structured line to a DEDICATED diagnostics log
   (data/logs/offline_events.jsonl + .log) so the cause of every breaker trip /
   queued bill / quarantine survives even a normal app restart. This is separate
   from the noisy main app log on purpose.

None of these functions raise: diagnostics must never break billing.
"""
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict

from config.config import LOGS_DIR
from helpers.utils import read_json_file, write_json_file

# A queue item that fails this many times with a PERMANENT (non-network) error
# is moved to the poison store instead of being retried forever. Transient
# (network) failures do NOT count toward this — those retry indefinitely.
MAX_PERMANENT_ATTEMPTS = 5

OFFLINE_EVENTS_JSONL = os.path.join(LOGS_DIR, "offline_events.jsonl")
OFFLINE_EVENTS_LOG = os.path.join(LOGS_DIR, "offline_events.log")

# Keep each diagnostics file bounded so it can never grow without limit and feed
# the very disk/slowness spiral we are trying to kill.
_MAX_EVENT_LOG_BYTES = 5 * 1024 * 1024  # 5 MB, then rotate to <file>.1


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------
def classify_error(err: Exception | str) -> str:
    """Return "transient" or "permanent".

    transient = a connectivity problem (timeout / connection reset / DNS / the
        circuit being open). Worth retrying forever — it will succeed once the
        link is back.
    permanent = anything else (validation, constraint/duplicate, RLS, a genuine
        500 bug). Retrying won't help; after a few tries the item is quarantined.
    """
    try:
        # Lazy import avoids a circular import at module load time.
        from utils.connection_pool import _is_transport_error, SupabaseCircuitOpenError

        if isinstance(err, SupabaseCircuitOpenError):
            return "transient"
        if _is_transport_error(err):
            return "transient"
    except Exception:
        pass
    return "permanent"


# ---------------------------------------------------------------------------
# Dead-letter (poison) store — preserve, never delete
# ---------------------------------------------------------------------------
def register_failure(item: Dict[str, Any], err: Exception | str) -> str:
    """Record a failed attempt on a queue item in place and decide its fate.

    Returns "retry" (keep it in the live queue) or "poison" (move it to the
    dead-letter store). Transient (network) failures always retry; permanent
    failures retry only up to MAX_PERMANENT_ATTEMPTS, then quarantine.
    """
    item["attempts"] = int(item.get("attempts", 0)) + 1
    item["last_error"] = str(err)
    item["last_error_class"] = classify_error(err)
    item["updated_at"] = _utc_now()
    if item["last_error_class"] == "permanent" and item["attempts"] >= MAX_PERMANENT_ATTEMPTS:
        return "poison"
    return "retry"


def poison_file_for(queue_file: str) -> str:
    """The poison/dead-letter file that sits beside a live queue file."""
    if queue_file.endswith(".json"):
        return queue_file[: -len(".json")] + ".poison.json"
    return queue_file + ".poison.json"


def quarantine_item(queue_file: str, item: Dict[str, Any], reason: str) -> None:
    """Append a permanently-failed item to its poison file, preserving everything.

    Safe to call from the single-threaded write-back phase of a processor.
    """
    poison_file = poison_file_for(queue_file)
    record = {
        **item,
        "quarantined_at": _utc_now(),
        "quarantine_reason": str(reason),
    }
    existing = read_json_file(poison_file, [])
    if not isinstance(existing, list):
        existing = []
    existing.append(record)
    write_json_file(poison_file, existing)


# ---------------------------------------------------------------------------
# Dedicated offline diagnostics log
# ---------------------------------------------------------------------------
def _rotate_if_needed(path: str) -> None:
    try:
        if os.path.exists(path) and os.path.getsize(path) > _MAX_EVENT_LOG_BYTES:
            backup = f"{path}.1"
            if os.path.exists(backup):
                os.remove(backup)
            os.replace(path, backup)
    except OSError:
        pass


def _humanize(rec: Dict[str, Any]) -> str:
    ts = rec.get("ts", "")
    event = str(rec.get("event", "")).upper()
    extras = "  ".join(
        f"{k}={v}" for k, v in rec.items() if k not in ("ts", "event") and v is not None
    )
    return f"{ts}  {event:<22}  {extras}".rstrip()


def log_offline_event(event: str, **fields: Any) -> None:
    """Append one diagnostics event to offline_events.jsonl (+ human .log).

    Uses plain file appends (no Flask app context needed), so it is safe to call
    from worker threads. Never raises.
    """
    record = {"ts": _utc_now(), "event": event}
    for key, value in fields.items():
        if value is not None:
            record[key] = value

    try:
        _rotate_if_needed(OFFLINE_EVENTS_JSONL)
        with open(OFFLINE_EVENTS_JSONL, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except Exception:
        pass

    try:
        _rotate_if_needed(OFFLINE_EVENTS_LOG)
        with open(OFFLINE_EVENTS_LOG, "a", encoding="utf-8") as f:
            f.write(_humanize(record) + "\n")
    except Exception:
        pass
