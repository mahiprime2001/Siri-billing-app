"""
`@via_siri_api(group, path)`: send a READ route to siri-api when its switch is on, otherwise run the old code.

Put it directly under @require_auth on a GET route:

    @product_bp.route('/products', methods=['GET'])
    @require_auth
    @via_siri_api("reads", "/api/store/products")
    def get_products(): ...                      # the old code, untouched, still the fallback

Rules (they are what keep a store working):
  * switch OFF, no siri-api session, kill switch on, or a different cashier than the one siri-api knows
    -> the old code runs exactly as before; no network call is made;
  * switch ON -> the request goes to siri-api with the cashier's token. If siri-api cannot be reached, answers with
    a server fault, or no longer accepts the token -> the old code runs (so a siri-api outage never stops a store);
  * a normal "no" from siri-api (404, 403, 400...) is a real answer and is returned as it is: the old code has no
    per-store checks and must not be allowed to answer what siri-api refused;
  * only GET is ever forwarded. Writes have their own idempotency rules (a later step) and always run the old code;
  * nothing in here may raise: if the switch machinery itself fails, the old code runs.
"""
import json
import logging
from functools import wraps
from typing import Callable, Optional, Tuple, Union
from urllib.parse import quote

from flask import Response, request
from flask_jwt_extended import get_jwt_identity

from utils.siri_api import get_client

logger = logging.getLogger("main")

# Headers the screens read from the old backend's answers: pass them through.
_PASS_HEADERS = ("x-fallback-used", "x-data-source", "x-partial", "x-bills-fallback-used")

Transform = Callable[[int, object], Tuple[int, object]]


def via_siri_api(group: str, path: Union[str, Callable[..., str]], *, transform: Optional[Transform] = None):
    def decorator(legacy):
        @wraps(legacy)
        def wrapper(*args, **kwargs):
            if request.method != "GET":
                return legacy(*args, **kwargs)
            target = str(path)
            try:
                api = get_client()
                if not api.enabled(group) or get_jwt_identity() != api.session_user_id():
                    return legacy(*args, **kwargs)
                safe = {k: quote(str(v), safe="") for k, v in kwargs.items()}
                target = path(**safe) if callable(path) else path.format(**safe)
                resp = api.request("GET", target, params=list(request.args.items(multi=True)))
            except Exception as e:  # noqa: BLE001 - never let the switch machinery break a screen
                logger.warning("SIRI_API proxy error group=%s: %s; using the old path", group, e)
                return legacy(*args, **kwargs)

            if resp.unavailable:
                logger.warning("SIRI_API FALLBACK group=%s path=%s status=%s error=%s ms=%s",
                               group, target, resp.status, resp.error, resp.elapsed_ms)
                return legacy(*args, **kwargs)

            status, content = resp.status, resp.content
            if transform is not None:
                try:
                    status, parsed = transform(resp.status, resp.json())
                    content = json.dumps(parsed).encode("utf-8")
                except Exception as e:  # noqa: BLE001
                    logger.warning("SIRI_API transform failed group=%s path=%s: %s; using the old path", group, target, e)
                    return legacy(*args, **kwargs)
            out = Response(content, status=status, content_type=resp.headers.get("content-type", "application/json"))
            for name in _PASS_HEADERS:
                if name in resp.headers:
                    out.headers[name] = resp.headers[name]
            out.headers["X-Siri-Api"] = "1"
            logger.info("SIRI_API ok group=%s path=%s status=%s ms=%s", group, target, status, resp.elapsed_ms)
            return out
        return wrapper
    return decorator


def current_store_from_me(status: int, body):
    """siri-api's /api/store/me -> what the old /stores/current returned: just the store."""
    store = body.get("store") if isinstance(body, dict) else None
    return (200, store) if store else (404, {"message": "No store assigned to this user"})
