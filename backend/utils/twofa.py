import logging
from typing import Tuple

import pyotp

from utils.connection_pool import get_supabase_client

logger = logging.getLogger(__name__)


def verify_twofa(user_id: str, otp: str) -> Tuple[bool, str]:
    """
    Verify a TOTP code for the given user_id using Supabase-stored secret.
    Returns (is_valid, message).
    """
    try:
        supabase = get_supabase_client()
        resp = supabase.table("two_factor").select("secret").eq("user_id", user_id).limit(1).execute()
        if not resp.data:
            return False, "2FA not configured for this user"

        secret = resp.data[0]["secret"]
        totp = pyotp.TOTP(secret)
        if totp.verify(otp, valid_window=1):
            return True, "OTP verified"
        return False, "Invalid or expired code"
    except Exception as exc:  # pragma: no cover - defensive
        logger.error("Error verifying 2FA: %s", exc, exc_info=True)
        return False, "Verification failed"

