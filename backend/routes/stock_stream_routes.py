import queue
import time
from flask import Blueprint, Response, stream_with_context
from auth.auth import require_auth
from utils.stock_stream import subscribe, unsubscribe, keepalive_payload

stock_stream_bp = Blueprint('stock_stream', __name__)


@stock_stream_bp.route('/stock/stream', methods=['GET'])
@require_auth
def stock_stream():
    """
    Server-Sent Events stream for stock updates.
    """
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
