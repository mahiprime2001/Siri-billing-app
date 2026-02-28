"""
Supabase Client Manager

Manages a single Supabase client instance for efficient database access
"""

import os
from dotenv import load_dotenv
import logging
from typing import Optional
from supabase import create_client, Client
import httpx
import time
from threading import Lock
from utils.offline_supabase_fallback import OfflineSupabaseClient

# Load environment variables
DOTENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env')
load_dotenv(dotenv_path=DOTENV_PATH)

# Configure logging
logger = logging.getLogger('supabase_client')

# Global Supabase client instance
_supabase_client: Optional[Client] = None
_client_lock = Lock()
_offline_client = OfflineSupabaseClient()
_supabase_offline_until: float = 0.0
_last_probe_at: float = 0.0
_PROBE_INTERVAL_SECONDS = 10
_OFFLINE_COOLDOWN_SECONDS = 45


def _is_timeout_error(err: Exception) -> bool:
    timeout_types = (
        httpx.ConnectTimeout,
        httpx.ReadTimeout,
        httpx.WriteTimeout,
        httpx.ConnectError,
        httpx.ReadError,
        httpx.WriteError,
        httpx.RemoteProtocolError,
    )
    if isinstance(err, timeout_types):
        return True
    text = str(err).lower()
    return "timed out" in text or "timeout" in text


def _mark_supabase_offline(reason: Exception | str):
    global _supabase_offline_until
    _supabase_offline_until = time.time() + _OFFLINE_COOLDOWN_SECONDS
    logger.warning(f"⚠️ [CONNECTION-POOL] Supabase marked offline for {_OFFLINE_COOLDOWN_SECONDS}s: {reason}")


def _mark_supabase_online():
    global _supabase_offline_until
    if _supabase_offline_until != 0:
        logger.info("✅ [CONNECTION-POOL] Supabase connectivity restored; using Supabase as primary source")
    _supabase_offline_until = 0.0


def _is_supabase_offline() -> bool:
    return time.time() < _supabase_offline_until


class ResilientHTTPClient(httpx.Client):
    def request(self, method, url, *args, **kwargs):  # type: ignore[override]
        if _is_supabase_offline():
            raise httpx.ConnectTimeout("Supabase offline circuit is open")
        try:
            response = super().request(method, url, *args, **kwargs)
            _mark_supabase_online()
            return response
        except Exception as e:
            if _is_timeout_error(e):
                _mark_supabase_offline(e)
            raise

def initialize_supabase_client():
    """Initialize the Supabase client with HTTP/1.1 only"""
    global _supabase_client
    
    # Thread-safe check
    with _client_lock:
        if _supabase_client is not None:
            logger.info("✅ [CONNECTION-POOL] Supabase client already initialized")
            return _supabase_client

        try:
            supabase_url = os.getenv("SUPABASE_URL")
            supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY")
            
            if not supabase_url or not supabase_key:
                raise ValueError(
                    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY) must be set."
                )

            if not os.getenv("SUPABASE_SERVICE_ROLE_KEY"):
                logger.warning(
                    "⚠️ [CONNECTION-POOL] SUPABASE_SERVICE_ROLE_KEY not set; "
                    "falling back to SUPABASE_KEY. RLS may block some inserts (e.g., billitems)."
                )
            
            logger.info(f"🔄 [CONNECTION-POOL] Creating new Supabase client...")
            logger.info(f"📍 [CONNECTION-POOL] URL: {supabase_url}")
            
            # ✅ FIX: Create custom httpx client with HTTP/1.1 only to prevent PROTOCOL_ERROR
            custom_http_client = ResilientHTTPClient(
                http2=False,  # Disable HTTP/2
                timeout=httpx.Timeout(30.0, connect=10.0),
                limits=httpx.Limits(
                    max_connections=50,  # Max concurrent connections
                    max_keepalive_connections=10,  # Connections to keep alive
                    keepalive_expiry=60.0  # Keep connections alive for 60 seconds
                ),
                verify=True,  # Verify SSL certificates
            )
            
            # Create Supabase client
            _supabase_client = create_client(supabase_url, supabase_key)
            
            # ✅ Replace the default httpx client with our custom one
            _supabase_client.postgrest.session = custom_http_client
            
            logger.info("✅ [CONNECTION-POOL] Supabase client initialized successfully (HTTP/1.1 only)")
            logger.info(f"🔧 [CONNECTION-POOL] Max connections: 50, Keepalive: 10, Timeout: 30s")
            
            return _supabase_client
            
        except Exception as e:
            logger.error(f"❌ [CONNECTION-POOL] Error initializing Supabase client: {e}")
            return None

def get_supabase_client():
    """
    Get the initialized Supabase client.
    Initializes it if not already initialized.
    """
    global _supabase_client, _last_probe_at
    
    if _supabase_client is None:
        initialize_supabase_client()

    if _supabase_client is None:
        logger.error("❌ [CONNECTION-POOL] Supabase client not available; using offline JSON client")
        return _offline_client

    if _is_supabase_offline():
        now = time.time()
        if now - _last_probe_at >= _PROBE_INTERVAL_SECONDS:
            _last_probe_at = now
            try:
                _supabase_client.from_("app_config").select("id").limit(1).execute()
                _mark_supabase_online()
            except Exception as e:
                if _is_timeout_error(e):
                    _mark_supabase_offline(e)
                return _offline_client
        else:
            return _offline_client

    return _supabase_client

def close_supabase_client():
    """Close the Supabase client and cleanup resources"""
    global _supabase_client
    
    with _client_lock:
        if _supabase_client is not None:
            try:
                # Close the httpx client
                if hasattr(_supabase_client.postgrest, 'session'):
                    _supabase_client.postgrest.session.close()
                    logger.info("🔴 [CONNECTION-POOL] Supabase HTTP client closed")
            except Exception as e:
                logger.error(f"⚠️ [CONNECTION-POOL] Error closing client: {e}")
            finally:
                _supabase_client = None
                logger.info("🔴 [CONNECTION-POOL] Supabase client instance cleared")

def reset_supabase_client():
    """
    Force reset the Supabase client.
    Useful for recovering from connection errors.
    """
    logger.info("🔄 [CONNECTION-POOL] Resetting Supabase client...")
    close_supabase_client()
    return initialize_supabase_client()

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
        "http_version": "HTTP/1.1",
        "connection_pool": {
            "max_connections": 50,
            "max_keepalive_connections": 10,
            "keepalive_expiry": "60s",
        }
    }
