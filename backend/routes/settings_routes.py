from flask import Blueprint, jsonify, current_app as app

from auth.auth import session_required # Changed from token_required
from data_access.data_access import get_system_settings_data

settings_bp = Blueprint('settings_bp', __name__)

@settings_bp.route('/settings', methods=['GET'])
@session_required
def get_settings():
    """Get system settings"""
    try:
        settings = get_system_settings_data()
        return jsonify(settings), 200
    except Exception as e:
        app.logger.error(f"Error getting settings: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500
