"""
`@via_siri_api(group, path)`: send a route to siri-api when its switch is on, otherwise run the old code.

Put it directly under @require_auth:

    @product_bp.route('/products', methods=['GET'])
    @require_auth
    @via_siri_api("reads", "/api/store/products")
    def get_products(): ...                      # the old code, untouched, still the fallback

Rules (they are what keep a store working):
  * switch OFF, no siri-api session, kill switch on, or a different cashier than the one siri-api knows
    -> the old code runs exactly as before; no network call is made;
  * switch ON -> the request goes to siri-api with the cashier's token;
  * a normal "no" from siri-api (404, 403, 400...) is a real answer and is returned as it is: the old code has no
    per-store checks and must not be allowed to answer what siri-api refused;
  * nothing in here may raise: if the switch machinery itself fails, the old code runs.

WHEN SIRI-API CANNOT ANSWER (no answer, a server fault, a refused token):
  * a READ (repeatable=True, the default) simply falls back to the old code: reading twice changes nothing;
  * a WRITE (repeatable=False) falls back ONLY when the request provably never left this PC (refused connection,
    no session) or the token was refused (401: nothing was done). If siri-api MAY have done the work (a timeout, a
    dropped connection, a server fault) the old path is NOT run, because it could do the work a second time (the old
    "approve a return" would restock twice). The cashier gets a retryable 503 instead, and siri-api's own
    guards (a return can only be approved once, ...) make pressing the button again safe.
  * writes that have an offline queue (bills, damaged returns, return orders, transfer verifications) are not
    handled here: they go through services/siri_bills.py and services/siri_writes.py, which queue instead.

`methods` says which HTTP methods are forwarded (default GET only); others always run the old code.
`after(status, body)` runs when siri-api answered successfully (used to remember a discount approval).
"""
import json
import logging
from functools import wraps
from typing import Callable, Optional, Sequence, Tuple, Union
from urllib.parse import quote

from flask import Response, jsonify, request
from flask_jwt_extended import get_jwt_identity

from utils.siri_api import get_client

logger = logging.getLogger("main")

# Headers the screens read from the old backend's answers: pass them through.
_PASS_HEADERS = ("x-fallback-used", "x-data-source", "x-partial", "x-bills-fallback-used")
_BODY_METHODS = ("POST", "PUT", "PATCH", "DELETE")

Transform = Callable[[int, object], Tuple[int, object]]


def via_siri_api(group: str, path: Union[str, Callable[..., str]], *, transform: Optional[Transform] = None,
                 methods: Sequence[str] = ("GET",), repeatable: bool = True,
                 after: Optional[Callable[[int, object], None]] = None):
    def decorator(legacy):
        @wraps(legacy)
        def wrapper(*args, **kwargs):
            if request.method not in methods:
                return legacy(*args, **kwargs)
            target = str(path)
            try:
                api = get_client()
                if not api.enabled(group) or get_jwt_identity() != api.session_user_id():
                    return legacy(*args, **kwargs)
                safe = {k: quote(str(v), safe="") for k, v in kwargs.items()}
                target = path(**safe) if callable(path) else path.format(**safe)
                body = request.get_json(silent=True) if request.method in _BODY_METHODS else None
                resp = api.request(request.method, target, params=list(request.args.items(multi=True)), json_body=body,
                                   timeout=25.0 if request.method in _BODY_METHODS else None)
            except Exception as e:  # noqa: BLE001 - never let the switch machinery break a screen
                logger.warning("SIRI_API proxy error group=%s: %s; using the old path", group, e)
                return legacy(*args, **kwargs)

            if resp.unavailable:
                logger.warning("SIRI_API FALLBACK group=%s %s %s status=%s error=%s ms=%s",
                               group, request.method, target, resp.status, resp.error, resp.elapsed_ms)
                if repeatable or resp.status == 401 or resp.not_sent:
                    return legacy(*args, **kwargs)
                # A write siri-api may have done: never repeat it down the old path. The cashier can press again.
                return jsonify({"message": "The server did not confirm this action. Please check and try again.",
                                "code": "siri_unclear", "retryable": True}), 503

            status, content = resp.status, resp.content
            if transform is not None:
                try:
                    status, parsed = transform(resp.status, resp.json())
                    content = json.dumps(parsed).encode("utf-8")
                except Exception as e:  # noqa: BLE001
                    logger.warning("SIRI_API transform failed group=%s path=%s: %s; using the old path", group, target, e)
                    return legacy(*args, **kwargs)
            if after is not None and 200 <= resp.status < 300:
                try:
                    after(resp.status, resp.json())
                except Exception as e:  # noqa: BLE001 - a follow-up must never fail an answer siri-api already gave
                    logger.warning("SIRI_API follow-up failed group=%s path=%s: %s", group, target, e)
            out = Response(content, status=status, content_type=resp.headers.get("content-type", "application/json"))
            for name in _PASS_HEADERS:
                if name in resp.headers:
                    out.headers[name] = resp.headers[name]
            out.headers["X-Siri-Api"] = "1"
            logger.info("SIRI_API ok group=%s %s %s status=%s ms=%s", group, request.method, target, status, resp.elapsed_ms)
            return out
        return wrapper
    return decorator


def current_store_from_me(status: int, body):
    """siri-api's /api/store/me -> what the old /stores/current returned: just the store."""
    store = body.get("store") if isinstance(body, dict) else None
    return (200, store) if store else (404, {"message": "No store assigned to this user"})
