import os
import sys
import logging
from logging.handlers import TimedRotatingFileHandler
from flask import Flask
import io
from datetime import datetime, timedelta
import glob
import platform


def cleanup_old_logs(logs_dir: str, retention_days: int = 30):
    """
    Delete log files older than retention_days
    """
    try:
        cutoff_date = datetime.now() - timedelta(days=retention_days)
        log_pattern = os.path.join(logs_dir, "billing_app*.log*")
        deleted_count = 0
        
        for log_file in glob.glob(log_pattern):
            try:
                # Skip the current log file (don't delete the active one)
                if log_file.endswith('.log') and not any(c.isdigit() for c in os.path.basename(log_file).split('.')[0][-10:]):
                    continue
                
                # Get file modification time
                file_mtime = datetime.fromtimestamp(os.path.getmtime(log_file))
                
                if file_mtime < cutoff_date:
                    # ✅ Windows-safe deletion
                    try:
                        os.remove(log_file)
                        deleted_count += 1
                        print(f"🗑️ Deleted old log: {os.path.basename(log_file)}")
                    except PermissionError:
                        print(f"⚠️ Cannot delete {os.path.basename(log_file)} (file in use)")
                        
            except Exception as e:
                print(f"⚠️ Failed to process {log_file}: {e}")
        
        if deleted_count > 0:
            print(f"✅ Cleaned up {deleted_count} old log file(s)")
        else:
            print(f"✅ No old logs to clean (retention: {retention_days} days)")
            
    except Exception as e:
        print(f"❌ Error during log cleanup: {e}")


def setup_logging(app: Flask, log_file: str, retention_days: int = 30):
    """
    Configure logging for the Flask application with Windows-compatible handlers.
    
    Args:
        app: Flask application instance
        log_file: Path to the log file
        retention_days: Number of days to keep logs (default: 30)
    """
    
    # Fix Windows console encoding for Unicode characters
    if sys.platform == 'win32':
        try:
            sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
            sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
        except AttributeError:
            pass  # Already wrapped or not needed
    
    # Get logs directory from log_file path
    logs_dir = os.path.dirname(log_file)
    
    # Create logs directory if it doesn't exist
    os.makedirs(logs_dir, exist_ok=True)
    
    # ✅ Cleanup old logs on startup
    cleanup_old_logs(logs_dir, retention_days)
    
    # Clear any existing handlers to avoid duplicates
    app.logger.handlers.clear()
    
    # ✅ Windows-compatible file handler
    is_windows = platform.system() == 'Windows'
    
    if is_windows:
        # ✅ On Windows: Use simple FileHandler to avoid file locking issues
        # The file will still rotate, but we'll handle it differently
        file_handler = logging.FileHandler(
            filename=log_file,
            encoding='utf-8',
            delay=False
        )
        file_handler.setLevel(logging.DEBUG)
        
    else:
        # ✅ On Linux/Mac: Use TimedRotatingFileHandler
        file_handler = TimedRotatingFileHandler(
            filename=log_file,
            when='midnight',
            interval=1,
            backupCount=retention_days,
            encoding='utf-8',
            delay=False,
            utc=False
        )
        file_handler.suffix = "%Y-%m-%d"
        file_handler.setLevel(logging.DEBUG)
    
    # Set logging format
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s'
    )
    file_handler.setFormatter(formatter)
    
    # Add file handler to app logger
    app.logger.addHandler(file_handler)
    app.logger.setLevel(logging.DEBUG)
    
    # ✅ Console handler (for terminal output)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.INFO)
    console_formatter = logging.Formatter(
        '[%(asctime)s] %(levelname)s in %(module)s: %(message)s'
    )
    console_handler.setFormatter(console_formatter)
    app.logger.addHandler(console_handler)
    
    # Log configuration details
    app.logger.info("=" * 80)
    app.logger.info(f"✅ Logging configured for {platform.system()}")
    app.logger.info(f"📁 Log file: {log_file}")
    app.logger.info(f"🗓️ Retention: {retention_days} days")
    
    if is_windows:
        app.logger.info(f"🔄 Rotation: Manual (Windows mode - prevents file locking)")
    else:
        app.logger.info(f"🔄 Rotation: Daily at midnight")
        
    app.logger.info("=" * 80)
    
    return app.logger
