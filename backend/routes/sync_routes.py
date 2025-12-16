from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.sync_controller import SyncController

sync_bp = Blueprint('sync', __name__)
sync_controller = SyncController()

@sync_bp.route('/sync/status', methods=['GET'])
@require_auth
def get_sync_status():
    """Get current sync status"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching sync status")
        
        status = sync_controller.get_sync_status()
        return jsonify(status), 200
    except Exception as e:
        app.logger.error(f"Error fetching sync status: {str(e)}")
        return jsonify({"message": "An error occurred"}), 500


@sync_bp.route('/sync/trigger', methods=['POST'])
@require_auth
def trigger_sync():
    """Manually trigger a sync operation"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} triggering manual sync")
        
        data = request.get_json() or {}
        sync_type = data.get('type', 'full')  # 'full' or 'incremental'
        
        if sync_type not in ['full', 'incremental']:
            return jsonify({"message": "Invalid sync type"}), 400
        
        result = sync_controller.trigger_sync(sync_type)
        
        return jsonify({
            "message": "Sync triggered successfully",
            "sync_type": sync_type,
            "result": result
        }), 200
        
    except Exception as e:
        app.logger.error(f"Error triggering sync: {str(e)}")
        return jsonify({"message": "An error occurred"}), 500


@sync_bp.route('/sync/history', methods=['GET'])
@require_auth
def get_sync_history():
    """Get sync history"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching sync history")
        
        limit = request.args.get('limit', 10, type=int)
        
        history = sync_controller.get_sync_history(limit=limit)
        
        return jsonify(history), 200
        
    except Exception as e:
        app.logger.error(f"Error fetching sync history: {str(e)}")
        return jsonify({"message": "An error occurred"}), 500
