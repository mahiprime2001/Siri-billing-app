"""
Local SQLite database — one file, many tables (see the JSON-to-SQLite
migration plan). Python/Flask owns this file directly; nothing on the
frontend touches it yet.

Each call opens and closes its own short-lived connection rather than
sharing one long-lived connection across threads. This app already runs
several background scheduler threads plus request-handling threads;
short-lived per-call connections plus SQLite's own WAL-mode file locking
handle that concurrency correctly without any extra locking of our own —
the exact kind of hand-rolled locking that caused the JSON-file bugs this
migration exists to get away from.
"""
import sqlite3
import logging
from contextlib import contextmanager

from config.config import SQLITE_DB_FILE

logger = logging.getLogger("sqlite_client")

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    selling_price REAL,
    stock INTEGER NOT NULL DEFAULT 0,
    batch_id TEXT,
    barcode TEXT,
    hsn_code_id INTEGER,
    created_at TEXT,
    updated_at TEXT,
    synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);

CREATE TABLE IF NOT EXISTS store_inventory (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    min_stock_level INTEGER DEFAULT 0,
    max_stock_level INTEGER,
    assigned_at TEXT,
    updated_at TEXT,
    synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_inventory_store_product ON store_inventory(store_id, product_id);
"""


@contextmanager
def get_connection():
    """Open a short-lived connection. Commits on success, rolls back on
    exception, always closes. Use one `with get_connection() as conn:` block
    per logical operation rather than holding a connection across calls."""
    conn = sqlite3.connect(SQLITE_DB_FILE, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def initialize_schema() -> None:
    """Create tables if they don't exist yet. Safe to call on every startup."""
    with get_connection() as conn:
        conn.executescript(SCHEMA)
    logger.info(f"SQLite schema ready at {SQLITE_DB_FILE}")
