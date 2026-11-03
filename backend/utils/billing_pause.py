"""
"Pause billing at this store while an audit runs" -- the backend's side.

The Tauri shell asks siri-api every ~30 s whether the admin paused this store's billing for an
audit, and writes the answer to `data/billing-pause.json`:

    {"paused": true, "message": "...", "since": "<ISO time>", "checkedAtEpoch": 1762000000}

`create_bill` reads it here and refuses to start a new bill while it says paused, so the rule
holds even if someone gets around the blocking dialog on the screen.

Fails OPEN on purpose: a missing, unreadable or stale file means "not paused". Billing must never
stop because of a bug here or because the PC lost internet while paused -- the file is only
believed for MAX_AGE_SECONDS after the shell last heard from siri-api.
"""
import json
import os
import time
from typing import Dict, Optional

MAX_AGE_SECONDS = 10 * 60


def _flag_path() -> str:
    explicit = os.environ.get("BILLING_PAUSE_FILE")
    if explicit:
        return explicit
    from config.config import DATA_DIR  # imported here so importing this module has no side effects

    return os.path.join(DATA_DIR, "billing-pause.json")


def current_pause(path: Optional[str] = None, now: Optional[float] = None) -> Optional[Dict[str, Optional[str]]]:
    """{"message", "since"} while billing is paused and the answer is fresh, otherwise None. Never raises."""
    try:
        with open(path or _flag_path(), "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, dict) or data.get("paused") is not True:
            return None
        checked = float(data.get("checkedAtEpoch") or 0)
        if (time.time() if now is None else now) - checked > MAX_AGE_SECONDS:
            return None
        return {
            "message": str(data.get("message") or "Billing is paused at this store."),
            "since": str(data["since"]) if data.get("since") else None,
        }
    except Exception:  # noqa: BLE001 - see the module docstring: fail open
        return None
