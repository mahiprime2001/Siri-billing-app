"""
Offline login without keeping anyone's real password on the PC.

When siri-api accepts a cashier's password (online login, "auth" switch on), a SCRAMBLED copy is kept here
(PBKDF2-SHA256, a random salt per person, 200,000 rounds). With no internet, the next login is checked against it.
The real password is never written to disk. (Before, the PC's users.json held every user's password in plain text,
copied straight from the database.)

    data/json/offline_credentials.json
        {"<email>": {"salt": hex, "hash": hex, "rounds": 200000,
                     "user": {"id", "name", "email", "role"}, "saved_at": iso}}

A person who has never logged in online on this PC since the switch went on cannot log in offline (nothing is known).
"""
import hashlib
import hmac
import json
import os
import secrets
import tempfile
import threading
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Set

from config.config import JSON_DIR

ROUNDS = 200_000
_lock = threading.Lock()


def _path() -> str:
    return os.path.join(JSON_DIR, "offline_credentials.json")


def _load() -> Dict[str, Any]:
    try:
        with open(_path(), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(data: Dict[str, Any]) -> None:
    folder = os.path.dirname(_path())
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".offline_credentials-", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1)
        os.replace(tmp, _path())
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _scramble(password: str, salt: bytes, rounds: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)


def save(email: str, password: str, user: Dict[str, Any]) -> None:
    """Remember a password siri-api has just accepted (scrambled). Never raises."""
    email = (email or "").strip().lower()
    if not email or not password or not user.get("id"):
        return
    try:
        salt = secrets.token_bytes(16)
        entry = {"salt": salt.hex(), "hash": _scramble(password, salt, ROUNDS).hex(), "rounds": ROUNDS,
                 "user": {k: user.get(k) for k in ("id", "name", "email", "role")},
                 "saved_at": datetime.now(timezone.utc).isoformat()}
        with _lock:
            data = _load()
            data[email] = entry
            _write(data)
    except Exception:  # noqa: BLE001 - offline login is a convenience; the online login already worked
        pass


def check(email: str, password: str) -> Optional[Dict[str, Any]]:
    """The person (id, name, email, role) when this matches the last password siri-api accepted, else None."""
    email = (email or "").strip().lower()
    entry = _load().get(email)
    if not isinstance(entry, dict) or not password:
        return None
    try:
        expected = bytes.fromhex(entry["hash"])
        got = _scramble(password, bytes.fromhex(entry["salt"]), int(entry.get("rounds") or ROUNDS))
    except (KeyError, ValueError, TypeError):
        return None
    if not hmac.compare_digest(expected, got):
        return None
    user = entry.get("user") or {}
    return user if user.get("id") else None


def forget(email: str) -> None:
    """siri-api said this password is wrong: the old scrambled copy must not let it in offline any more."""
    email = (email or "").strip().lower()
    with _lock:
        data = _load()
        if data.pop(email, None) is not None:
            try:
                _write(data)
            except Exception:  # noqa: BLE001
                pass


def known_user_ids() -> Set[str]:
    """Everyone siri-api has accepted on this PC (used by the per-request "does this user still exist" check)."""
    return {str((e.get("user") or {}).get("id")) for e in _load().values() if isinstance(e, dict) and (e.get("user") or {}).get("id")}
