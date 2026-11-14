from flask import Blueprint, jsonify
from datetime import datetime

health_bp = Blueprint('health_bp', __name__)

@health_bp.route('/update-policy', methods=['GET'])
def update_policy():
    """May this app install updates by itself, or must it install nothing? Set per store in siri-api's switches
    (auto_update / update_hold). Booleans only, nothing secret, so it needs no login (the login screen asks too).
    Unknown / siri-api unreachable / emergency kill switch => both false, which means "ask the user as before"."""
    try:
        from utils.siri_api import get_client
        api = get_client()
        # "ready": a cashier is signed in to siri-api, so the store's switches are fresh (before that they are only
        # remembered from an earlier day). The app waits for ready before it applies the once-a-day update.
        return jsonify({"auto_update": api.switch_on("auto_update"), "update_hold": api.switch_on("update_hold"),
                        "ready": api.has_session()}), 200
    except Exception:  # noqa: BLE001 - this must never break the screen
        return jsonify({"auto_update": False, "update_hold": False, "ready": False}), 200


@health_bp.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({
        "status": "online",
        "app": "billing",
        "timestamp": datetime.now().isoformat()
    }), 200
