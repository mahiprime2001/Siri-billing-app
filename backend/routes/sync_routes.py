from flask import Blueprint, jsonify, request, current_app as app

from auth.auth import session_required # Changed from token_required
from utils.sync_controller import SyncController
from config.config import (
    PRODUCTS_FILE, CUSTOMERS_FILE, USERS_FILE, STORES_FILE, SYSTEM_SETTINGS_FILE, RETURNS_FILE
)
from helpers.utils import write_json_file

sync_bp = Blueprint('sync_bp', __name__)
sync_controller = SyncController()

@sync_bp.route('/sync/status', methods=['GET'])
def api_sync_status():
    """Get sync status"""
    try:
        status = sync_controller.get_sync_status()
        return jsonify(status), 200
    except Exception as e:
        app.logger.error(f"Error getting sync status: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@sync_bp.route('/sync/push', methods=['POST'])
@session_required
def api_push_sync():
    """Manually trigger push sync"""
    try:
        data = request.json or {}
        sync_data = data.get('sync_data', {})
        
        if not sync_data:
            return jsonify({"error": "No sync data provided"}), 400
        
        result = sync_controller.push_sync(sync_data)
        return jsonify(result), 200
    except Exception as e:
        app.logger.error(f"Error in push sync: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500

@sync_bp.route('/sync/pull', methods=['POST'])
@session_required
def api_pull_sync():
    """Manually trigger pull sync"""
    try:
        data = request.json or {}
        last_sync = data.get('last_sync')
        tables = data.get('tables')
        
        result = sync_controller.pull_sync(last_sync, tables)
        
        # Save pulled data to JSON files
        if result['success']:
            for table_name, records in result.get('data', {}).items():
                if table_name == 'Products' and records:
                    write_json_file(PRODUCTS_FILE, records)
                    app.logger.info(f"Saved {len(records)} products to JSON")
                elif table_name == 'Customers' and records:
                    write_json_file(CUSTOMERS_FILE, records)
                    app.logger.info(f"Saved {len(records)} customers to JSON")
                elif table_name == 'Users' and records:
                    write_json_file(USERS_FILE, records)
                    app.logger.info(f"Saved {len(records)} users to JSON")
                elif table_name == 'Stores' and records:
                    write_json_file(STORES_FILE, records)
                    app.logger.info(f"Saved {len(records)} stores to JSON")
                elif table_name == 'SystemSettings' and records and len(records) > 0:
                    write_json_file(SYSTEM_SETTINGS_FILE, records[0])
                    app.logger.info(f"Saved system settings to JSON")
                elif table_name == 'Returns' and records:
                    write_json_file(RETURNS_FILE, records)
                    app.logger.info(f"Saved {len(records)} returns to JSON")
        
        return jsonify(result), 200
    except Exception as e:
        app.logger.error(f"Error in pull sync: {e}")
        return jsonify({"error": "Internal server error", "details": str(e)}), 500
