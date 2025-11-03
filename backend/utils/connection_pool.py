"""
MySQL Connection Pool Manager
Manages a pool of MySQL connections for efficient database access
"""

import os
os.environ["MYSQLCONNECTOR_PY_NO_CEXT"] = "1"

import mysql.connector
from mysql.connector import pooling, Error
from dotenv import load_dotenv
import logging

# Load environment variables
DOTENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env')
load_dotenv(dotenv_path=DOTENV_PATH)

plugin_dir = os.path.join(os.path.dirname(mysql.connector.__file__), "authentication.py")
os.environ["MYSQL_PLUGIN_DIR"] = os.path.dirname(plugin_dir)

# Configure logging
logger = logging.getLogger('connection_pool')

# Connection pool configuration
POOL_NAME = "siri_billing_pool"
POOL_SIZE = 10  # Number of connections in the pool

# Global pool instance
_connection_pool = None

def initialize_pool():
    """Initialize the MySQL connection pool"""
    global _connection_pool
    
    if _connection_pool is not None:
        logger.info("Connection pool already initialized")
        return _connection_pool
    
    try:
        db_config = {
            "host": os.getenv("MYSQL_HOST"),
            "user": os.getenv("MYSQL_USER"),
            "password": os.getenv("MYSQL_PASSWORD"),
            "database": os.getenv("MYSQL_DATABASE"),
            "autocommit": False,  # We'll manage transactions manually
            "connection_timeout": 10,
            "auth_plugin": "mysql_native_password",
        }
        
        # Validate env vars
        missing = [k for k, v in db_config.items() if v is None and k not in ["autocommit", "connection_timeout", "auth_plugin"]]
        if missing:
            raise ValueError(f"Missing database config values: {', '.join(missing)}")
        
        _connection_pool = pooling.MySQLConnectionPool(
            pool_name=POOL_NAME,
            pool_size=POOL_SIZE,
            pool_reset_session=True,
            **db_config
        )
        
        logger.info(f"MySQL connection pool initialized with {POOL_SIZE} connections")
        return _connection_pool
    
    except Error as e:
        logger.error(f"Error creating connection pool: {e}")
        return None
    except Exception as e:
        logger.error(f"Unexpected error creating connection pool: {e}")
        return None

def get_connection(dictionary: bool = True):
    """
    Get a connection from the pool.
    If `dictionary=True`, all cursors will default to dict mode.
    """
    global _connection_pool
    
    if _connection_pool is None:
        initialize_pool()
    
    if _connection_pool is None:
        logger.error("Connection pool not available")
        return None
    
    try:
        connection = _connection_pool.get_connection()
        
        # Monkey patch cursor() to always use dictionary=True if requested
        if dictionary:
            orig_cursor = connection.cursor
            def dict_cursor(*args, **kwargs):
                kwargs["dictionary"] = True
                return orig_cursor(*args, **kwargs)
            connection.cursor = dict_cursor
        
        return connection
    
    except Error as e:
        logger.error(f"Error getting connection from pool: {e}")
        return None
    except Exception as e:
        logger.error(f"Unexpected error getting connection from pool: {e}")
        return None

def close_pool():
    """Close all connections in the pool"""
    global _connection_pool
    
    if _connection_pool is not None:
        try:
            _connection_pool = None
            logger.info("Connection pool closed (connections will close automatically)")
        except Exception as e:
            logger.error(f"Error closing connection pool: {e}")

def get_pool_status():
    """Get the current status of the connection pool"""
    if _connection_pool is None:
        return {
            "initialized": False,
            "pool_size": 0,
            "available_connections": 0,
        }
    
    return {
        "initialized": True,
        "pool_name": POOL_NAME,
        "pool_size": POOL_SIZE,
        "status": "active",
    }
