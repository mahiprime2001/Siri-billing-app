import json
from datetime import datetime
from flask import current_app as app

from utils.connection_pool import get_connection

def log_session_event(change_type, user_id=None, details=None):
    """Log session events to sync_table in MySQL"""
    try:
        connection = get_connection()
        if not connection:
            app.logger.warning("No MySQL connection for session logging")
            return
        
        cursor = connection.cursor(dictionary=True)
        
        # Insert into sync_table
        query = """
        INSERT INTO sync_table (table_name, record_id, operation_type, change_data, source, status, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """
        
        change_data = json.dumps({
            'event': change_type,
            'user_id': user_id,
            'details': details,
            'timestamp': datetime.now().isoformat(),
            'app': 'billing'
        })
        
        params = (
            'session_events',  # table_name
            user_id or 'system',  # record_id
            'CREATE',  # operation_type
            change_data,  # change_data
            'local',  # source
            'synced',  # status
            datetime.now().isoformat()  # created_at
        )
        
        cursor.execute(query, params)
        connection.commit()
        app.logger.info(f"Session event logged: {change_type} for user {user_id}")
    
    except Exception as e:
        app.logger.error(f"Failed to log session event: {e}")
        if connection:
            connection.rollback()
    finally:
        if connection:
            connection.close()
