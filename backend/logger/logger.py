import os
import sys
import logging
from logging.handlers import RotatingFileHandler
from flask import Flask
import io


def setup_logging(app: Flask, log_file: str):
    """
    Configures logging for the Flask application.
    """
    # Fix Windows console encoding for Unicode characters
    if sys.platform == 'win32':
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

    # Clear log file on startup
    try:
        with open(log_file, 'w') as f:
            f.write('')
    except IOError as e:
        print(f"Warning: Could not clear log file: {e}")

    # Configure logging
    file_handler = RotatingFileHandler(log_file, maxBytes=10*1024*1024, backupCount=5, encoding='utf-8')
    file_handler.setLevel(logging.DEBUG)
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s')
    file_handler.setFormatter(formatter)
    app.logger.addHandler(file_handler)
    app.logger.setLevel(logging.DEBUG)

    # Dual logger for stdout/stderr
    class DualLogger:
        def __init__(self, filename, encoding='utf-8'):
            self.terminal = sys.stdout
            self.log = open(filename, 'a', encoding=encoding)
        
        def write(self, message):
            self.terminal.write(message)
            self.log.write(message)
            self.log.flush()
        
        def flush(self):
            self.terminal.flush()
            self.log.flush()

    sys.stdout = DualLogger(log_file)
    sys.stderr = DualLogger(log_file)

    app.logger.info("Logging configured.")
