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

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    created_at TEXT,
    updated_at TEXT,
    synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    name TEXT,
    address TEXT,
    phone TEXT,
    status TEXT,
    store_code TEXT,
    gst_registration_id TEXT,
    created_at TEXT,
    updated_at TEXT,
    synced_at TEXT NOT NULL
);

-- Deliberately excludes the plaintext `password` field present in users.json.
-- No reason to replicate that into a second local store; auth already goes
-- through JWT, not a local password check.
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    role TEXT,
    status TEXT,
    session_duration TEXT,
    last_login TEXT,
    last_logout TEXT,
    total_session_duration TEXT,
    created_at TEXT,
    updated_at TEXT,
    synced_at TEXT NOT NULL
);

-- userstores.json has no per-row id of its own (just {userId, storeId} pairs).
CREATE TABLE IF NOT EXISTS user_stores (
    user_id TEXT NOT NULL,
    store_id TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    PRIMARY KEY (user_id, store_id)
);

-- Single-row table in practice (system_settings.json is one JSON object, not
-- a list) but modeled as a normal table rather than a special case.
CREATE TABLE IF NOT EXISTS system_settings (
    id TEXT PRIMARY KEY,
    gstin TEXT,
    company_name TEXT,
    company_address TEXT,
    company_phone TEXT,
    company_email TEXT,
    created_at TEXT,
    updated_at TEXT,
    synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bills (
    id TEXT PRIMARY KEY,
    store_id TEXT,
    customer_id TEXT,
    user_id TEXT,
    subtotal REAL,
    discount_percentage REAL DEFAULT 0,
    discount_amount REAL DEFAULT 0,
    total REAL,
    payment_method TEXT,
    timestamp TEXT,
    status TEXT,
    created_by TEXT,
    created_at TEXT,
    updated_at TEXT,
    synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bills_store_created ON bills(store_id, created_at);

-- Canonical column names are unit_price/line_total, reconciling the
-- mismatch found between the offline snapshot writer (unitprice/itemtotal)
-- and the live Supabase insert (price/total) — both map into these two
-- columns when population code is written for this table.
CREATE TABLE IF NOT EXISTS bill_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id TEXT NOT NULL,
    product_id TEXT,
    quantity INTEGER NOT NULL DEFAULT 0,
    unit_price REAL,
    line_total REAL,
    tax_percentage REAL DEFAULT 0,
    hsn_code TEXT,
    name TEXT,
    barcode TEXT,
    created_at TEXT,
    updated_at TEXT,
    synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id);

-- Same unit_price/line_total canonicalization as bill_items above.
CREATE TABLE IF NOT EXISTS bill_item_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id TEXT NOT NULL,
    product_id TEXT,
    quantity INTEGER,
    unit_price REAL,
    line_total REAL,
    tax_percentage REAL DEFAULT 0,
    hsn_code TEXT,
    name TEXT,
    barcode TEXT,
    created_at TEXT,
    updated_at TEXT,
    synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bill_item_snapshots_bill ON bill_item_snapshots(bill_id);

-- Mirrors bill_idempotency.json's key shape ("{user_id}:{client_request_id}"
-- -> {bill_id, user_id, created_at}) as real columns instead of a
-- string-concatenated dict key.
CREATE TABLE IF NOT EXISTS bill_idempotency (
    user_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    bill_id TEXT NOT NULL,
    created_at TEXT,
    synced_at TEXT NOT NULL,
    PRIMARY KEY (user_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS store_damage_returns (
    id TEXT PRIMARY KEY,
    store_id TEXT,
    product_id TEXT,
    reason TEXT,
    reason_type TEXT,
    notes TEXT,
    quantity INTEGER,
    damage_origin TEXT,
    status TEXT,
    resolution_status TEXT,
    resolution_notes TEXT,
    resolved_by TEXT,
    resolved_at TEXT,
    repaired_by TEXT,
    repaired_qty INTEGER,
    repair_notes TEXT,
    repaired_at TEXT,
    restock_qty INTEGER,
    restock_action TEXT,
    created_by TEXT,
    created_at TEXT,
    updated_at TEXT,
    synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_damage_returns_store ON store_damage_returns(store_id);

-- Schema for the future SQLite-backed offline queue (see the migration
-- plan's Phase 3+) — one table with a queue_type discriminator, reused by
-- every queue including bills eventually, ported from
-- backend/utils/queue_common.py's proven state machine. Defined now,
-- unpopulated until a queue is actually moved onto it.
CREATE TABLE IF NOT EXISTS offline_queue_items (
    queue_id TEXT PRIMARY KEY,
    queue_type TEXT NOT NULL,
    client_request_id TEXT,
    user_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    consecutive_permanent_failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_error_class TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    quarantined_at TEXT,
    quarantine_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_offline_queue_type_status ON offline_queue_items(queue_type, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_offline_queue_client_request
    ON offline_queue_items(queue_type, client_request_id)
    WHERE client_request_id IS NOT NULL;

-- Not yet defined: bill_formats.json and returns.json are both empty on
-- disk with no confirmed real-world shape to model against (unlike
-- everything above, which was checked against actual production data).
-- Add these when a phase actually needs them rather than guess a schema
-- now. Same reasoning applies to the longer tail of rarely-used tables
-- (discounts, two_factor, replacements, inventory_transfer_*,
-- damaged_inventory_events, app_config, notifications, hsn_codes) —
-- covered by TABLE_FILE_MAP in offline_supabase_fallback.py today; add
-- them to this schema one at a time, when each is actually migrated.
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
