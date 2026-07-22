import json
import os
import time
import threading
from datetime import datetime, date
from decimal import Decimal
from flask import current_app as app

# Backwards-compat: some modules may still import this symbol. It is no longer
# used to guard every file (that single global lock serialized ALL json reads
# and writes, so a slow sync write could block a cashier's bill save). We now
# use a lock-per-file (see _lock_for) so unrelated files never block each other.
file_lock = threading.Lock()

_locks_guard = threading.Lock()
_file_locks: dict[str, threading.Lock] = {}


def _lock_for(file_path: str) -> threading.Lock:
    """Return a dedicated lock for a single file path.

    Each distinct file gets its own lock, so writing bills.json never blocks the
    offline queue file (and vice-versa). Paths are normalized so the same file
    referenced different ways still shares one lock.
    """
    key = os.path.normcase(os.path.abspath(file_path))
    with _locks_guard:
        lock = _file_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _file_locks[key] = lock
        return lock


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

    The temp filename includes our own PID so that if a second backend process
    ever ends up running against the same data folder (e.g. an orphaned
    instance), the two processes can't both open the *same* tmp file and
    interleave their writes into it before either calls os.replace — that
    cross-process race silently produced a garbled file even though each
    process's own write+rename was individually atomic.

    Returns True on success, False on failure (and logs it). Existing callers can
    ignore the return value; the offline queue paths check it so they never
    report success for data that did not actually persist.
    """
    tmp_path = f"{file_path}.{os.getpid()}.tmp"
    with _lock_for(file_path):
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
    """Read JSON file with fallback default.

    On a parse error the file is corrupt (most commonly from two backend
    processes racing to write it — see write_json_file). We still return
    default_value so callers keep working, but a corrupt file used to just
    silently vanish into an empty list with one easy-to-miss log line, which
    looked like "the app is randomly broken" with no obvious cause. Now the
    corrupt file is preserved as a ``.corrupt-<ts>`` backup (same pattern as
    read_json_file_strict) and logged loudly, so there's hard evidence to
    diagnose instead of a mystery.
    """
    if default_value is None:
        default_value = []

    with _lock_for(file_path):
        if not os.path.exists(file_path):
            return default_value
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            app.logger.error(f"Error reading file {file_path}: {e}")
            if isinstance(e, json.JSONDecodeError):
                backup = f"{file_path}.corrupt-{int(time.time())}"
                try:
                    os.replace(file_path, backup)
                    app.logger.error(
                        f"🚨 CORRUPT DATA FILE: {file_path} was not valid JSON and has been "
                        f"backed up to {backup} instead of being silently discarded. The app "
                        f"is now treating it as empty ({default_value!r}) until it is "
                        "restored or resynced. This usually means two backend processes "
                        "wrote to this file at the same time."
                    )
                except OSError as backup_err:
                    app.logger.error(
                        f"🚨 CORRUPT DATA FILE: {file_path} was not valid JSON and could not "
                        f"be backed up ({backup_err}); it is being left in place."
                    )
            return default_value


def read_json_file_strict(file_path):
    """Read a JSON list/file without silently masking corruption.

    Unlike read_json_file, a parse error does NOT return a default. The corrupt
    file is moved aside to ``<path>.corrupt-<ts>`` (preserving the data for
    recovery and freeing the path so the app keeps working) and a QueueReadError
    is raised. Use this for the offline queue files, where returning [] would let
    the next write erase everything that was queued.
    """
    with _lock_for(file_path):
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
