import queue
import time
from flask import Blueprint, Response, stream_with_context, request, jsonify, current_app as app
from flask_jwt_extended import verify_jwt_in_request, decode_token
from utils.stock_stream import subscribe, unsubscribe, keepalive_payload

stock_stream_bp = Blueprint('stock_stream', __name__)


def _authorize_stream() -> bool:
    """Authorize the SSE stream request.

    EventSource cannot send the Authorization header, and the JWT cookie can be
    blocked cross-site in the packaged (Tauri) app, so the stream would 401 and
    never connect. Accept the token via the query string for THIS endpoint only;
    fall back to the normal header/cookie check.
    """
    token = request.args.get("token")
    if token:
        try:
            decode_token(token)  # validates signature + expiry; raises otherwise
            return True
        except Exception as e:
            app.logger.warning(f"Stock stream query-token auth failed: {e}")
            return False
    try:
        verify_jwt_in_request()
        return True
    except Exception:
        return False


@stock_stream_bp.route('/stock/stream', methods=['GET'])
def stock_stream():
    """
    Server-Sent Events stream for stock updates.
    """
    if not _authorize_stream():
        return jsonify({"message": "Authentication required"}), 401

    q = subscribe()

    def event_stream():
        try:
            # Initial connect event
            yield "event: connected\ndata: {}\n\n"
            while True:
                try:
                    payload = q.get(timeout=15)
                    yield f"event: stock\ndata: {payload}\n\n"
                except queue.Empty:
                    # Keepalive ping every 15s
                    yield f"event: keepalive\ndata: {keepalive_payload()}\n\n"
        except GeneratorExit:
            pass
        finally:
            unsubscribe(q)

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }

    return Response(stream_with_context(event_stream()), headers=headers, mimetype="text/event-stream")
