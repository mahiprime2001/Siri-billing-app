from datetime import datetime
from flask import current_app as app

from data_access.mysql_data_access import sync_to_mysql_immediately

def create_notification(notification_type, message, related_id=None):
    """Create a notification and sync to MySQL"""
    notification = {
        'id': int(datetime.now().timestamp() * 1000),  # Use timestamp as ID
        'type': notification_type,
        'notification': message,
        'related_id': related_id,
        'is_read': 0,
        'created_at': datetime.now().isoformat(),
        'updated_at': datetime.now().isoformat()
    }
    
    sync_to_mysql_immediately('Notifications', notification, 'INSERT')
    app.logger.info(f"Created notification: {notification_type} - {message}")
    return notification
