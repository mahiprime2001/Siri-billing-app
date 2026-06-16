import json
import os
import time
import threading
from datetime import datetime, date
from decimal import Decimal
from flask import current_app as app

file_lock = threading.Lock()


class QueueReadError(Exception):
    """Raised when a queue file exists but cannot be parsed.

    Callers must NOT silently fall back to an empty list (that is what used to
    erase the offline queue): the corrupt file is preserved as a
    ``.corrupt-<ts>`` backup so it can be recovered, and the caller is expected
    to abort the operation instead of overwriting the queue.
    """
    pass

def json_serial(obj):
    """JSON serializer for datetime and Decimal objects"""
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError(f"Type {type(obj)} not serializable")

def write_json_file(file_path, data):
    """Write JSON data atomically and thread-safely.

    Serializes to a temp file, fsyncs it, then atomically replaces the target via
    os.replace (atomic on Windows and POSIX). This guarantees readers always see
    either the previous complete file or the new complete file — never a
    half-written/truncated one. A truncated file was the root cause of the
    offline queue being wiped: a crash mid-write left corrupt JSON, which
    read_json_file then turned into [] and the next write erased everything.

    Returns True on success, False on failure (and logs it). Existing callers can
    ignore the return value; the offline queue paths check it so they never
    report success for data that did not actually persist.
    """
    tmp_path = f"{file_path}.tmp"
    with file_lock:
        try:
            with open(tmp_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=4, default=json_serial, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, file_path)
            return True
        except Exception as e:
            app.logger.error(f"Error writing to file {file_path}: {e}")
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass
            return False

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


def read_json_file_strict(file_path):
    """Read a JSON list/file without silently masking corruption.

    Unlike read_json_file, a parse error does NOT return a default. The corrupt
    file is moved aside to ``<path>.corrupt-<ts>`` (preserving the data for
    recovery and freeing the path so the app keeps working) and a QueueReadError
    is raised. Use this for the offline queue files, where returning [] would let
    the next write erase everything that was queued.
    """
    with file_lock:
        if not os.path.exists(file_path):
            return []
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except json.JSONDecodeError as e:
            backup = f"{file_path}.corrupt-{int(time.time())}"
            try:
                os.replace(file_path, backup)
                app.logger.error(
                    f"Corrupt queue file {file_path} backed up to {backup}: {e}"
                )
            except OSError as backup_err:
                app.logger.error(
                    f"Corrupt queue file {file_path}; backup failed: {backup_err}"
                )
            raise QueueReadError(f"Queue file {file_path} was corrupt (backed up): {e}")
