"""
The store app's client for siri-api (https://api.ifleon.com).

WHY: today this backend talks to the database directly with the master key. The migration moves each group of
routes onto siri-api (which checks which store a login belongs to) one at a time. This module is the bridge:

  * after a normal local login it ALSO logs in to siri-api in the background. That gives it an access token
    and the long-lived "replay passes" (one per store) that let the offline queues send their bills later,
    when nobody is logged in;
  * it asks siri-api which route groups are switched ON for this store (`GET /api/store/config`). All groups are
    OFF unless an admin switched them on, so installing this changes nothing by itself;
  * it makes the HTTP calls, and says plainly whether siri-api could not be reached ("unavailable") so the caller
    can fall back to the old path.

NOTHING HERE CAN BREAK A SCREEN: every failure is turned into an answer, never an exception. A local kill
switch turns everything off: set SIRI_API_DISABLE=1, or create an empty file `siri_disabled.flag` in the data
folder.

Files kept in the data folder:
    siri_session.json   {"user_id", "role", "store_ids", "access_token", "replay_tokens": {store_id: token}, "saved_at"}
    siri_switches.json  {"fetched_at": <epoch seconds>, "switches": {group: true/false}}
The session file holds tokens: treat it like the rest of the app's data folder.
"""
import json
import logging
import os
import tempfile
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx

from config.config import DATA_DIR

logger = logging.getLogger("main")   # the same logger the rest of the backend uses, so these lines are shipped too

DEFAULT_URL = "https://api.ifleon.com"
REQUEST_TIMEOUT = 10.0
LOGIN_TIMEOUT = 8.0
SWITCH_TIMEOUT = 3.0
SWITCH_REFRESH_SECONDS = 120      # how long the switches are trusted before asking again
SWITCH_RETRY_SECONDS = 30         # after a failed ask, wait this long before asking again
SWITCH_MAX_AGE_SECONDS = 24 * 3600  # a remembered answer older than this is not trusted
GROUPS = ("reads", "bills_read", "bills_write", "returns", "transfers", "discounts", "small_writes")
# Error kinds (the exception's class name) that mean the request never reached siri-api.
_NOT_SENT_ERRORS = ("ConnectError", "ConnectTimeout", "PoolTimeout", "UnsupportedProtocol", "InvalidURL", "ProxyError",
                    "no siri-api session", "no replay pass for this cashier")


class SiriResponse:
    """What came back from siri-api, or why nothing did. Never raises."""

    __slots__ = ("status", "content", "headers", "error", "elapsed_ms")

    def __init__(self, status: int = 0, content: bytes = b"", headers: Optional[Dict[str, str]] = None,
                 error: Optional[str] = None, elapsed_ms: int = 0):
        self.status, self.content, self.headers, self.error, self.elapsed_ms = status, content, headers or {}, error, elapsed_ms

    @property
    def unavailable(self) -> bool:
        """True when the caller should fall back to the old path: no answer at all, a server fault, or a token siri-api
        no longer accepts. A 4xx like 404/403 is a real answer (siri-api understood and said no)."""
        return self.error is not None or self.status >= 500 or self.status == 401

    @property
    def not_sent(self) -> bool:
        """True only when the request provably never left this PC (no session, connection refused, could not even
        connect). Then nothing can have been saved, so the old path may safely be tried. A read timeout, a dropped
        connection or a server fault are NOT 'not sent': siri-api may have saved the work."""
        if self.error is None:
            return False
        return self.error.split(":", 1)[0].strip() in _NOT_SENT_ERRORS

    def json(self) -> Any:
        try:
            return json.loads(self.content.decode("utf-8")) if self.content else None
        except (ValueError, UnicodeDecodeError):
            return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json_atomic(path: str, data: Any) -> None:
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".siri-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_json(path: str) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001 - missing or damaged file = nothing remembered
        return None


class SiriApi:
    def __init__(self, *, base_url: Optional[str] = None, data_dir: Optional[str] = None,
                 transport: Optional[httpx.BaseTransport] = None, clock=time.time):
        self._base = (base_url or os.environ.get("SIRI_API_URL") or DEFAULT_URL).rstrip("/")
        folder = data_dir or DATA_DIR
        self._session_path = os.path.join(folder, "siri_session.json")
        self._switch_path = os.path.join(folder, "siri_switches.json")
        self._kill_path = os.path.join(folder, "siri_disabled.flag")
        self._transport = transport
        self._clock = clock
        self._lock = threading.RLock()
        self._session: Optional[Dict[str, Any]] = None
        self._switch_cache: Optional[tuple] = None      # (fetched_at_epoch, {group: bool})

    # ------------------------------------------------------------ session

    def _load_session(self) -> Dict[str, Any]:
        with self._lock:
            if self._session is None:
                data = _read_json(self._session_path)
                self._session = data if isinstance(data, dict) else {}
            return self._session

    def _save_session(self, session: Dict[str, Any]) -> None:
        with self._lock:
            self._session = session
            try:
                _write_json_atomic(self._session_path, session)
            except Exception as e:  # noqa: BLE001 - still works for this run, just not remembered
                logger.warning("SIRI_API could not save its session file: %s", e)

    def has_session(self) -> bool:
        return bool(self._load_session().get("access_token"))

    def session_user_id(self) -> Optional[str]:
        return self._load_session().get("user_id")

    def store_ids(self) -> List[str]:
        ids = self._load_session().get("store_ids")
        return [str(i) for i in ids] if isinstance(ids, list) else []

    def replay_token(self, store_id: Optional[str] = None, user_id: Optional[str] = None) -> Optional[str]:
        """The replay pass for this store, of this cashier when `user_id` is given (else the latest login's)."""
        session = self._load_session()
        if user_id is not None:
            tokens = (session.get("replay_by_user") or {}).get(str(user_id))
        else:
            tokens = session.get("replay_tokens")
        if not isinstance(tokens, dict) or not tokens:
            return None
        if store_id is not None:
            return tokens.get(str(store_id))
        return next(iter(tokens.values()))

    def _drop_replay_pass(self, user_id: Optional[str], store_id: Optional[str]) -> None:
        """siri-api no longer accepts this pass (an admin revoked it): forget it so the old path is used until the
        cashier logs in again and gets a new one."""
        with self._lock:
            session = dict(self._load_session())
            by_user = {u: dict(t) for u, t in (session.get("replay_by_user") or {}).items() if isinstance(t, dict)}
            if user_id is not None and str(user_id) in by_user and store_id is not None:
                by_user[str(user_id)].pop(str(store_id), None)
            session["replay_by_user"] = by_user
            self._save_session(session)

    def drop_access_token(self) -> None:
        """Forget the access token (it expired, or the cashier logged out). The replay passes are kept on purpose:
        they are what lets queued offline bills be sent when nobody is logged in."""
        with self._lock:
            session = dict(self._load_session())
            if session.pop("access_token", None) is not None:
                self._save_session(session)
            self._switch_cache = None

    # ------------------------------------------------------------ http

    def _send(self, method: str, path: str, *, token: Optional[str], params=None, json_body=None,
              timeout: float = REQUEST_TIMEOUT) -> SiriResponse:
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        started = time.time()
        try:
            with httpx.Client(base_url=self._base, timeout=timeout, transport=self._transport) as client:
                r = client.request(method, path, params=params, json=json_body, headers=headers)
            return SiriResponse(r.status_code, r.content, {k.lower(): v for k, v in r.headers.items()}, None,
                                int((time.time() - started) * 1000))
        except Exception as e:  # noqa: BLE001 - timeouts, DNS, TLS, a dead connection: all just "no answer"
            return SiriResponse(0, b"", {}, f"{type(e).__name__}: {e}"[:200], int((time.time() - started) * 1000))

    def request(self, method: str, path: str, *, params=None, json_body=None, replay: bool = False,
                store_id: Optional[str] = None, user_id: Optional[str] = None,
                timeout: Optional[float] = None) -> SiriResponse:
        """A call to siri-api as the logged-in cashier (or, with replay=True, with that cashier's replay pass)."""
        token = self.replay_token(store_id, user_id) if replay else self._load_session().get("access_token")
        if not token:
            return SiriResponse(0, b"", {}, "no siri-api session" if not replay else "no replay pass for this cashier")
        resp = self._send(method, path, token=token, params=params, json_body=json_body, timeout=timeout or REQUEST_TIMEOUT)
        if replay and resp.status == 401:
            logger.warning("SIRI_API replay pass refused (401) user=%s store=%s: using the old path until the next login",
                           user_id, store_id)
            self._drop_replay_pass(user_id, store_id)
        if not replay:
            fresh = resp.headers.get("x-access-token")          # siri-api renews a token that is close to expiring
            if fresh and resp.status < 400:
                with self._lock:
                    session = dict(self._load_session())
                    session["access_token"] = fresh
                    self._save_session(session)
            if resp.status == 401:
                logger.warning("SIRI_API token no longer accepted (401); falling back to the old path until the next login")
                self.drop_access_token()
        return resp

    # ------------------------------------------------------------ login

    def login(self, email: str, password: str) -> bool:
        """Log in to siri-api and remember the token + replay passes. False when it did not work (never raises)."""
        resp = self._send("POST", "/api/auth/login", token=None, json_body={"email": email, "password": password},
                          timeout=LOGIN_TIMEOUT)
        body = resp.json() if resp.error is None else None
        if resp.status == 200 and isinstance(body, dict) and body.get("access_token"):
            user = body.get("user") if isinstance(body.get("user"), dict) else {}
            # A replay pass belongs to the cashier who logged in. Keep every cashier's passes (not only the latest),
            # so a bill queued by one cashier is sent under that cashier's name even if another logs in later.
            by_user = dict(self._load_session().get("replay_by_user") or {})
            if user.get("id") and body.get("replay_tokens"):
                by_user[user["id"]] = body["replay_tokens"]
            session = {
                "user_id": user.get("id"), "role": body.get("user_role"), "store_ids": body.get("store_ids") or [],
                "access_token": body["access_token"], "replay_tokens": body.get("replay_tokens") or {},
                "replay_by_user": by_user, "saved_at": _now_iso(),
            }
            with self._lock:
                self._save_session(session)
                self._switch_cache = None
            logger.info("SIRI_API login ok user=%s stores=%s replay_passes=%d ms=%d", user.get("id"), session["store_ids"],
                        len(session["replay_tokens"]), resp.elapsed_ms)
            return True
        logger.info("SIRI_API login not done status=%s error=%s ms=%d", resp.status, resp.error, resp.elapsed_ms)
        return False

    def login_in_background(self, email: str, password: str) -> None:
        """Fire and forget: the cashier's own login must never wait for, or fail because of, siri-api."""
        def run():
            try:
                if self.login(email, password):
                    self.switches(force=True)
            except Exception as e:  # noqa: BLE001
                logger.warning("SIRI_API background login failed: %s", e)
        threading.Thread(target=run, name="siri-api-login", daemon=True).start()

    # ------------------------------------------------------------ switches

    def killed(self) -> bool:
        """The local emergency off: everything goes the old way."""
        return os.environ.get("SIRI_API_DISABLE", "").strip().lower() in ("1", "true", "yes") or os.path.exists(self._kill_path)

    def _fetch_switches(self) -> Optional[Dict[str, bool]]:
        resp = self.request("GET", "/api/store/config", timeout=SWITCH_TIMEOUT)
        body = resp.json() if resp.error is None and resp.status == 200 else None
        if not isinstance(body, dict) or not isinstance(body.get("switches"), dict):
            return None
        return {g: body["switches"].get(g) is True for g in GROUPS}

    def switches(self, force: bool = False) -> Dict[str, bool]:
        """Every group -> on/off for this computer's store. All off when killed, or when nothing trustworthy is known."""
        off = {g: False for g in GROUPS}
        if self.killed():
            return off
        now = self._clock()
        with self._lock:
            cached = self._switch_cache
        if cached and not force and now - cached[0] < SWITCH_REFRESH_SECONDS:
            return dict(cached[1])
        fresh = self._fetch_switches() if self.has_session() else None
        if fresh is not None:
            with self._lock:
                self._switch_cache = (now, fresh)
            try:
                _write_json_atomic(self._switch_path, {"fetched_at": now, "switches": fresh})
            except Exception:  # noqa: BLE001
                pass
            return dict(fresh)
        # Could not ask: keep the last known answer for a while, but do not hammer siri-api with retries.
        known = cached[1] if cached else None
        if known is None:
            remembered = _read_json(self._switch_path)
            if isinstance(remembered, dict) and isinstance(remembered.get("switches"), dict):
                try:
                    fresh_enough = now - float(remembered.get("fetched_at", 0)) < SWITCH_MAX_AGE_SECONDS
                except (TypeError, ValueError):
                    fresh_enough = False
                if fresh_enough:
                    known = {g: remembered["switches"].get(g) is True for g in GROUPS}
        known = known or off
        with self._lock:
            self._switch_cache = (now - SWITCH_REFRESH_SECONDS + SWITCH_RETRY_SECONDS, known)
        return dict(known)

    def enabled(self, group: str) -> bool:
        """Should this group's requests go to siri-api right now?"""
        if group not in GROUPS or self.killed() or not self.has_session():
            return False
        return self.switches().get(group) is True

    def switch_on(self, group: str) -> bool:
        """Is this group switched on, even with nobody logged in? (The offline queue sends bills in the background,
        when no cashier has to be signed in: it uses the remembered switches and the cashier's replay pass.)"""
        if group not in GROUPS or self.killed():
            return False
        return self.switches().get(group) is True


_client: Optional[SiriApi] = None
_client_lock = threading.Lock()


def get_client() -> SiriApi:
    global _client
    with _client_lock:
        if _client is None:
            _client = SiriApi()
        return _client
