"""
Supabase Client Manager
Manages a single Supabase client instance for efficient database access
"""

import os
from dotenv import load_dotenv
import logging
from typing import Optional
from supabase import create_client, Client

# Load environment variables
DOTENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env')
load_dotenv(dotenv_path=DOTENV_PATH)

# Configure logging
logger = logging.getLogger('supabase_client')

# Global Supabase client instance
_supabase_client: Optional[Client] = None

def initialize_supabase_client():
    """Initialize the Supabase client"""
    global _supabase_client
    
    if _supabase_client is not None:
        logger.info("Supabase client already initialized")
        return _supabase_client
    
    try:
        supabase_url = os.getenv("SUPABASE_URL")
        supabase_key = os.getenv("SUPABASE_KEY")
        
        if not supabase_url or not supabase_key:
            raise ValueError("SUPABASE_URL and SUPABASE_KEY must be set in environment variables.")
        
        _supabase_client = create_client(supabase_url, supabase_key)
        
        logger.info("Supabase client initialized successfully")
        return _supabase_client
    
    except Exception as e:
        logger.error(f"Error initializing Supabase client: {e}")
        return None

def get_supabase_client():
    """
    Get the initialized Supabase client.
    Initializes it if not already initialized.
    """
    global _supabase_client
    
    if _supabase_client is None:
        initialize_supabase_client()
    
    if _supabase_client is None:
        logger.error("Supabase client not available")
        return None
    
    return _supabase_client

def close_supabase_client():
    """No explicit close needed for Supabase client (managed by library)"""
    global _supabase_client
    if _supabase_client is not None:
        _supabase_client = None
        logger.info("Supabase client instance cleared.")

def get_client_status():
    """Get the current status of the Supabase client"""
    if _supabase_client is None:
        return {
            "initialized": False,
            "status": "not initialized",
        }
    
    return {
        "initialized": True,
        "status": "active",
    }

