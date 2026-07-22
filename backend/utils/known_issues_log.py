"""
TEMPORARY diagnostic log — tracks whether the Supabase-connectivity auth
fallback in auth/auth.py is still firing in production.

require_auth() used to log a user out (401) whenever the "does this user
still exist" Supabase check failed for any reason, including a plain DNS
blip. That's fixed: the check is now best-effort and the request proceeds
on failure. But the *underlying* connectivity flakiness (see the earlier
investigation into siriarts.ifleon.com DNS resolution) is not fixed — this
log exists purely so we can tell, from the outside, whether that fallback
path is still being hit and how often.

Once the underlying connectivity issue is confirmed resolved (this file
stops growing), delete this module and its one call site in auth/auth.py.
"""
import os
import time

from config.config import LOGS_DIR

KNOWN_ISSUES_LOG_FILE = os.path.join(LOGS_DIR, "known_issues.log")


def log_known_issue(source: str, message: str) -> None:
    """Best-effort append of one diagnostic line. Never raises."""
    try:
        os.makedirs(os.path.dirname(KNOWN_ISSUES_LOG_FILE), exist_ok=True)
        line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')}  {source:<24}  {message}\n"
        with open(KNOWN_ISSUES_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass
