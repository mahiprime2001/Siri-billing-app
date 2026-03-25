"""
Supabase Client Manager

Manages a single Supabase client instance for efficient database access
"""

import os
from dotenv import load_dotenv
import logging
from typing import Optional, Any
from supabase import create_client, Client
import httpx
import time
import random
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
_probe_lock = Lock()
_offline_client = OfflineSupabaseClient()
_supabase_offline_until: float = 0.0
_last_probe_at: float = 0.0
_last_success_at: float = 0.0
_last_failure_at: float = 0.0
_last_error: str = ""
_consecutive_network_failures: int = 0
_consecutive_probe_failures: int = 0
_PROBE_INTERVAL_SECONDS = 5
_BASE_OFFLINE_COOLDOWN_SECONDS = 3
_MAX_OFFLINE_COOLDOWN_SECONDS = 15
_PROBE_FAILURE_RESET_THRESHOLD = 3
_MAX_CONNECTIONS = 30
_MAX_KEEPALIVE_CONNECTIONS = 8
_KEEPALIVE_EXPIRY_SECONDS = 45.0


class SupabaseCircuitOpenError(Exception):
    """Raised when Supabase circuit breaker is open."""
    pass


def _is_network_offline_error(err: Exception | str) -> bool:
    timeout_types: tuple[type[Any], ...] = (
        httpx.ConnectTimeout,
        httpx.ReadTimeout,
        httpx.WriteTimeout,
        httpx.ConnectError,
        httpx.ReadError,
        httpx.WriteError,
        httpx.RemoteProtocolError,
    )
    if isinstance(err, SupabaseCircuitOpenError):
        return False
    if isinstance(err, timeout_types):
        return True
    text = str(err).lower()
    return any(
        token in text
        for token in [
            "timed out",
            "timeout",
            "connection reset",
            "connection refused",
            "temporary failure",
            "name resolution",
            "dns",
            "bad gateway",
            "gateway timeout",
            "502",
            "503",
            "504",
            "remoteprotocolerror",
        ]
    )


def _is_server_error_response(response: httpx.Response) -> bool:
    return response.status_code >= 500


def _mark_supabase_offline(reason: Exception | str):
    global _supabase_offline_until, _last_failure_at, _last_error, _consecutive_network_failures
    now = time.time()
    _consecutive_network_failures += 1
    cooldown = min(
        _MAX_OFFLINE_COOLDOWN_SECONDS,
        _BASE_OFFLINE_COOLDOWN_SECONDS * (2 ** max(0, _consecutive_network_failures - 1)),
    )
    # Add light jitter so multiple workers don't probe at the exact same moment.
    jitter = random.uniform(0, 2.0)
    _supabase_offline_until = max(_supabase_offline_until, now + cooldown + jitter)
    _last_failure_at = now
    _last_error = str(reason)
    logger.warning(
        f"⚠️ [CONNECTION-POOL] Supabase marked offline for ~{int(cooldown)}s "
        f"(failures={_consecutive_network_failures}): {reason}"
    )


def _mark_supabase_online():
    global _supabase_offline_until, _last_success_at, _consecutive_network_failures, _consecutive_probe_failures, _last_error
    if _supabase_offline_until != 0:
        logger.info("✅ [CONNECTION-POOL] Supabase connectivity restored; using Supabase as primary source")
    _supabase_offline_until = 0.0
    _last_success_at = time.time()
    _consecutive_network_failures = 0
    _consecutive_probe_failures = 0
    _last_error = ""


def _is_supabase_offline() -> bool:
    return time.time() < _supabase_offline_until


def _offline_remaining_seconds() -> int:
    return max(0, int(_supabase_offline_until - time.time()))


class ResilientHTTPClient(httpx.Client):
    def request(self, method, url, *args, **kwargs):  # type: ignore[override]
        if _is_supabase_offline():
            raise SupabaseCircuitOpenError(
                f"Supabase offline circuit is open ({_offline_remaining_seconds()}s remaining)"
            )
        try:
            response = super().request(method, url, *args, **kwargs)
            if _is_server_error_response(response):
                _mark_supabase_offline(f"HTTP {response.status_code} for {url}")
            else:
                _mark_supabase_online()
            return response
        except Exception as e:
            if _is_network_offline_error(e):
                _mark_supabase_offline(e)
            raise


def _probe_supabase_health() -> bool:
    global _last_probe_at, _consecutive_probe_failures
    with _probe_lock:
        _last_probe_at = time.time()
        if _supabase_client is None:
            return False
        try:
            _supabase_client.from_("systemsettings").select("id").limit(1).execute()
            _mark_supabase_online()
            return True
        except Exception as probe_error:
            if _is_network_offline_error(probe_error):
                _mark_supabase_offline(probe_error)
            _consecutive_probe_failures += 1
            logger.warning(
                f"⚠️ [CONNECTION-POOL] Supabase probe failed "
                f"(consecutive_probe_failures={_consecutive_probe_failures}): {probe_error}"
            )
            if _consecutive_probe_failures >= _PROBE_FAILURE_RESET_THRESHOLD:
                logger.warning("🔄 [CONNECTION-POOL] Repeated probe failures, resetting Supabase client.")
                reset_supabase_client()
                try:
                    if _supabase_client is not None:
                        _supabase_client.from_("systemsettings").select("id").limit(1).execute()
                        _mark_supabase_online()
                        return True
                except Exception as reset_probe_error:
                    if _is_network_offline_error(reset_probe_error):
                        _mark_supabase_offline(reset_probe_error)
                    logger.warning(f"⚠️ [CONNECTION-POOL] Probe after reset failed: {reset_probe_error}")
            return False

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
                    max_connections=_MAX_CONNECTIONS,  # Max concurrent connections
                    max_keepalive_connections=_MAX_KEEPALIVE_CONNECTIONS,  # Connections to keep alive
                    keepalive_expiry=_KEEPALIVE_EXPIRY_SECONDS
                ),
                verify=True,  # Verify SSL certificates
            )
            
            # Create Supabase client
            _supabase_client = create_client(supabase_url, supabase_key)
            
            # ✅ Replace the default httpx client with our custom one
            _supabase_client.postgrest.session = custom_http_client
            
            logger.info("✅ [CONNECTION-POOL] Supabase client initialized successfully (HTTP/1.1 only)")
            logger.info(
                f"🔧 [CONNECTION-POOL] Max connections: {_MAX_CONNECTIONS}, "
                f"Keepalive: {_MAX_KEEPALIVE_CONNECTIONS}, Timeout: 30s"
            )
            
            return _supabase_client
            
        except Exception as e:
            logger.error(f"❌ [CONNECTION-POOL] Error initializing Supabase client: {e}")
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
        logger.error("❌ [CONNECTION-POOL] Supabase client not available; using offline JSON client")
        return _offline_client

    if _is_supabase_offline():
        # Respect cooldown window first; do not keep extending it through immediate probes.
        if _offline_remaining_seconds() > 0:
            return _offline_client
        # Cooldown expired; probe once per interval before switching back to cloud.
        if time.time() - _last_probe_at < _PROBE_INTERVAL_SECONDS:
            return _offline_client
        if not _probe_supabase_health():
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


def warmup_supabase_connection() -> bool:
    """
    Attempt a one-time startup probe to avoid stale offline state.
    Returns True if Supabase is reachable, else False.
    """
    client = get_supabase_client()
    if not client or getattr(client, "is_offline_fallback", False):
        return False
    return _probe_supabase_health()

def get_client_status():
    """Get the current status of the Supabase client"""
    if _supabase_client is None:
        return {
            "initialized": False,
            "status": "not initialized",
            "mode": "fallback",
            "offline_remaining_seconds": _offline_remaining_seconds(),
            "probe_interval_seconds": _PROBE_INTERVAL_SECONDS,
            "last_probe_at": _last_probe_at or None,
            "last_success_at": _last_success_at or None,
            "last_failure_at": _last_failure_at or None,
            "last_error": _last_error or None,
            "consecutive_network_failures": _consecutive_network_failures,
            "consecutive_probe_failures": _consecutive_probe_failures,
        }
    
    return {
        "initialized": True,
        "status": "active" if not _is_supabase_offline() else "cooldown",
        "mode": "cloud" if not _is_supabase_offline() else "fallback",
        "http_version": "HTTP/1.1",
        "offline_remaining_seconds": _offline_remaining_seconds(),
        "probe_interval_seconds": _PROBE_INTERVAL_SECONDS,
        "last_probe_at": _last_probe_at or None,
        "last_success_at": _last_success_at or None,
        "last_failure_at": _last_failure_at or None,
        "last_error": _last_error or None,
        "consecutive_network_failures": _consecutive_network_failures,
        "consecutive_probe_failures": _consecutive_probe_failures,
        "connection_pool": {
            "max_connections": _MAX_CONNECTIONS,
            "max_keepalive_connections": _MAX_KEEPALIVE_CONNECTIONS,
            "keepalive_expiry": f"{int(_KEEPALIVE_EXPIRY_SECONDS)}s",
        }
    }
