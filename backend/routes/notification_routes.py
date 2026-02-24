from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client
from datetime import datetime, timezone
from helpers.utils import read_json_file
import os

notification_bp = Blueprint('notification', __name__)
NOTIFICATIONS_CACHE_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "json",
    "notifications.json",
)

@notification_bp.route('/notifications', methods=['GET'])
@require_auth
def get_notifications():
    """Get all notifications"""
    try:
        current_user_id = get_jwt_identity()
        limit = request.args.get('limit', 50, type=int)
        unread_only = request.args.get('unread_only', 'false').lower() == 'true'
        
        app.logger.info(f"📬 User {current_user_id} fetching notifications")
        
        supabase = get_supabase_client()
        query = supabase.table('notifications').select('*')
        
        if unread_only:
            query = query.eq('is_read', False)
        
        response = query.limit(limit).order('created_at', desc=True).execute()
        notifications = response.data if response.data else []
        
        app.logger.info(f"✅ Fetched {len(notifications)} notifications")
        
        return jsonify(notifications), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching notifications: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        notifications = read_json_file(NOTIFICATIONS_CACHE_FILE, [])
        if unread_only:
            notifications = [n for n in notifications if not n.get("is_read")]
        return jsonify(notifications[:limit]), 200


@notification_bp.route('/notifications/unread/count', methods=['GET'])
@require_auth
def get_unread_count():
    """Get count of unread notifications"""
    try:
        current_user_id = get_jwt_identity()
        supabase = get_supabase_client()
        
        response = supabase.table('notifications').select('id', count='exact').eq('is_read', False).execute()
        count = response.count if hasattr(response, 'count') else len(response.data or [])
        
        app.logger.debug(f"📊 User {current_user_id} has {count} unread notifications")
        
        return jsonify({"count": count}), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error fetching unread count: {str(e)}")
        notifications = read_json_file(NOTIFICATIONS_CACHE_FILE, [])
        count = len([n for n in notifications if not n.get("is_read")])
        return jsonify({"count": count}), 200


@notification_bp.route('/notifications/<int:notification_id>/read', methods=['POST'])
@require_auth
def mark_as_read(notification_id):
    """Mark notification as read"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"✅ User {current_user_id} marking notification {notification_id} as read")
        
        supabase = get_supabase_client()
        
        update_data = {
            'is_read': True,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        response = supabase.table('notifications').update(update_data).eq('id', notification_id).execute()
        
        if not response.data or len(response.data) == 0:
            return jsonify({"message": "Notification not found"}), 404
        
        return jsonify(response.data[0]), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error marking notification as read: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred"}), 500


@notification_bp.route('/notifications/read-all', methods=['POST'])
@require_auth
def mark_all_as_read():
    """Mark all notifications as read"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"✅ User {current_user_id} marking all notifications as read")
        
        supabase = get_supabase_client()
        
        update_data = {
            'is_read': True,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        response = supabase.table('notifications').update(update_data).eq('is_read', False).execute()
        
        count = len(response.data) if response.data else 0
        app.logger.info(f"✅ Marked {count} notifications as read")
        
        return jsonify({"message": f"Marked {count} notifications as read", "count": count}), 200
        
    except Exception as e:
        app.logger.error(f"❌ Error marking all as read: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred"}), 500
