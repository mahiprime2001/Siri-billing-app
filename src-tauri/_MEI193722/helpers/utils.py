import json
import os
import threading
from datetime import datetime, date
from decimal import Decimal
from flask import current_app as app

file_lock = threading.Lock()

def json_serial(obj):
    """JSON serializer for datetime and Decimal objects"""
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError(f"Type {type(obj)} not serializable")

def write_json_file(file_path, data):
    """Write JSON data to file with thread safety"""
    with file_lock:
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=4, default=json_serial, ensure_ascii=False)
        except IOError as e:
            app.logger.error(f"Error writing to file {file_path}: {e}")

def read_json_file(file_path, default_value=None):
    """Read JSON file with fallback default"""
    if default_value is None:
        default_value = []
    
    with file_lock:
        if not os.path.exists(file_path):
            return default_value
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            app.logger.error(f"Error reading file {file_path}: {e}")
            return default_value
