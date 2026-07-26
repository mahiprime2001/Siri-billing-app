"""
One-time (safe to re-run) setup + population check for the new local SQLite
database (Phase 1-2 of the JSON-to-SQLite migration plan).

What this does
---------------
1. Creates data/siri_billing.db and its schema if not already present.
2. Mirrors the current products.json / storeinventory.json into the new
   `products` / `store_inventory` tables (upsert by id — safe to re-run,
   re-running just refreshes the mirror from the current JSON files).
3. Prints row counts and a few sample rows from SQLite so the result can be
   inspected directly, without needing a separate DB browser tool.

This does NOT touch the JSON files, does NOT change how the running app
reads/writes data yet, and does NOT require the app to be stopped — it only
adds new tables to a new file. Safe to run anytime, safe to re-run.

Usage (run from the backend folder, with the backend's Python env):
    python -m scripts.init_sqlite_db
"""
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from config.config import PRODUCTS_FILE, STOREINVENTORY_FILE, SQLITE_DB_FILE  # noqa: E402
from helpers.utils import read_json_file  # noqa: E402
from db.sqlite_client import get_connection, initialize_schema  # noqa: E402


def _utc_now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def mirror_products() -> int:
    products = read_json_file(PRODUCTS_FILE, [])
    if not isinstance(products, list):
        products = []
    synced_at = _utc_now_iso()

    with get_connection() as conn:
        for p in products:
            conn.execute(
                """
                INSERT INTO products (id, name, price, selling_price, stock, batch_id,
                                       barcode, hsn_code_id, created_at, updated_at, synced_at)
                VALUES (:id, :name, :price, :selling_price, :stock, :batch_id,
                        :barcode, :hsn_code_id, :created_at, :updated_at, :synced_at)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name, price=excluded.price, selling_price=excluded.selling_price,
                    stock=excluded.stock, batch_id=excluded.batch_id, barcode=excluded.barcode,
                    hsn_code_id=excluded.hsn_code_id, created_at=excluded.created_at,
                    updated_at=excluded.updated_at, synced_at=excluded.synced_at
                """,
                {
                    "id": p.get("id"),
                    "name": p.get("name"),
                    "price": p.get("price") or 0,
                    "selling_price": p.get("selling_price"),
                    "stock": p.get("stock") or 0,
                    "batch_id": p.get("batchid"),
                    "barcode": p.get("barcode"),
                    "hsn_code_id": p.get("hsn_code_id"),
                    "created_at": p.get("createdat"),
                    "updated_at": p.get("updatedat"),
                    "synced_at": synced_at,
                },
            )
    return len(products)


def mirror_store_inventory() -> int:
    rows = read_json_file(STOREINVENTORY_FILE, [])
    if not isinstance(rows, list):
        rows = []
    synced_at = _utc_now_iso()

    with get_connection() as conn:
        for r in rows:
            conn.execute(
                """
                INSERT INTO store_inventory (id, store_id, product_id, quantity, min_stock_level,
                                              max_stock_level, assigned_at, updated_at, synced_at)
                VALUES (:id, :store_id, :product_id, :quantity, :min_stock_level,
                        :max_stock_level, :assigned_at, :updated_at, :synced_at)
                ON CONFLICT(id) DO UPDATE SET
                    store_id=excluded.store_id, product_id=excluded.product_id,
                    quantity=excluded.quantity, min_stock_level=excluded.min_stock_level,
                    max_stock_level=excluded.max_stock_level, assigned_at=excluded.assigned_at,
                    updated_at=excluded.updated_at, synced_at=excluded.synced_at
                """,
                {
                    "id": r.get("id"),
                    "store_id": r.get("storeid"),
                    "product_id": r.get("productid"),
                    "quantity": r.get("quantity") or 0,
                    "min_stock_level": r.get("minstocklevel") or 0,
                    "max_stock_level": r.get("maxstocklevel"),
                    "assigned_at": r.get("assignedat"),
                    "updated_at": r.get("updatedat"),
                    "synced_at": synced_at,
                },
            )
    return len(rows)


def report():
    with get_connection() as conn:
        products_count = conn.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"]
        inventory_count = conn.execute("SELECT COUNT(*) AS c FROM store_inventory").fetchone()["c"]
        sample_products = conn.execute("SELECT id, name, price, stock, barcode FROM products LIMIT 5").fetchall()
        sample_inventory = conn.execute(
            "SELECT id, store_id, product_id, quantity FROM store_inventory LIMIT 5"
        ).fetchall()

    print(f"SQLite DB file: {SQLITE_DB_FILE}")
    print(f"products: {products_count} rows")
    for row in sample_products:
        print(f"  - {row['id']}  {row['name']!r}  price={row['price']}  stock={row['stock']}  barcode={row['barcode']}")
    print(f"store_inventory: {inventory_count} rows")
    for row in sample_inventory:
        print(f"  - {row['id']}  store={row['store_id']}  product={row['product_id']}  qty={row['quantity']}")


if __name__ == "__main__":
    initialize_schema()
    n_products = mirror_products()
    n_inventory = mirror_store_inventory()
    print(f"Mirrored {n_products} product(s) and {n_inventory} store_inventory row(s) from JSON into SQLite.\n")
    report()
