import json
from datetime import datetime
from flask import current_app as app

from utils.connection_pool import get_supabase_client
from supabase import Client

def log_session_event(change_type, user_id=None, details=None):
    """Log session events to sync_table in Supabase"""
    supabase: Client = None
    try:
        supabase = get_supabase_client()
        if not supabase:
            app.logger.warning("No Supabase client for session logging")
            return
        
        change_data = json.dumps({
            'event': change_type,
            'user_id': user_id,
            'details': details,
            'timestamp': datetime.now().isoformat(),
            'app': 'billing'
        })
        
        insert_data = {
            "table_name": 'session_events',  # table_name
            "record_id": user_id or 'system',  # record_id
            "operation_type": 'CREATE',  # operation_type
            "change_data": change_data,  # change_data
            "source": 'local',  # source
            "status": 'synced',  # status
            "created_at": datetime.now().isoformat()  # created_at
        }
        
        response = supabase.from_("sync_table").insert(insert_data).execute()
        
        if response.data:
            app.logger.info(f"Session event logged: {change_type} for user {user_id}")
        else:
            app.logger.error(f"Failed to log session event: {response.status_code} {response.json()}")
    
    except Exception as e:
        app.logger.error(f"Failed to log session event: {e}")
