"""
One-time recovery for offline bills that were stranded locally.

Background
----------
Offline bills are written to BOTH the offline queue and a local snapshot in
bills.json / billitems.json. The bulk JSON->Supabase push is intentionally
disabled (sync_controller.push_sync), so the offline queue is the ONLY path that
carries an offline bill to the cloud. When the queue file was corrupted by a
non-atomic write (now fixed) and silently reset to [], those bills never reached
Supabase -- but their data still exists in the local snapshot files.

This script reconciles the local snapshot against Supabase and re-creates any
bill that is missing from the cloud, reusing the same tested code path
(create_bill_transaction with a forced bill id, which is idempotent and reduces
cloud stock correctly).

Usage (run from the backend folder, with the backend's Python env)
------------------------------------------------------------------
    python -m scripts.recover_offline_bills                # DRY RUN: report only
    python -m scripts.recover_offline_bills --apply        # actually recover
    python -m scripts.recover_offline_bills --limit 50     # cap how many to touch
    python -m scripts.recover_offline_bills --store STORE_ID

Safe to re-run: bills already present in Supabase are skipped, and
create_bill_transaction de-duplicates on the forced bill id.
"""

import argparse
import os
import sys

# Allow running both as a module (-m scripts.recover_offline_bills) and directly.
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from config.config import BILLS_FILE, JSON_DIR  # noqa: E402
from helpers.utils import read_json_file  # noqa: E402
from utils.connection_pool import get_supabase_client  # noqa: E402
from services.billing_service import create_bill_transaction  # noqa: E402

BILL_ITEMS_FILE = os.path.join(JSON_DIR, "billitems.json")


def _val(row, *keys, default=None):
    for k in keys:
        if k in row and row[k] not in (None, ""):
            return row[k]
    return default


def _items_by_bill():
    rows = read_json_file(BILL_ITEMS_FILE, [])
    grouped = {}
    if isinstance(rows, list):
        for it in rows:
            if not isinstance(it, dict):
                continue
            bid = str(_val(it, "billid", "billId", default="")).strip()
            if bid:
                grouped.setdefault(bid, []).append(it)
    return grouped


def _build_payload(bill, items):
    return {
        "store_id": _val(bill, "storeid", "storeId"),
        "customer_id": _val(bill, "customerid", "customerId"),
        "subtotal": _val(bill, "subtotal", default=_val(bill, "total", default=0)),
        "tax_amount": _val(bill, "tax_amount", default=0),
        "discount_percentage": _val(bill, "discount_percentage", default=0),
        "discount_amount": _val(bill, "discount_amount", default=0),
        "total_amount": _val(bill, "total", "total_amount", default=0),
        "payment_method": _val(bill, "paymentmethod", "payment_method", default="Cash"),
        "timestamp": _val(bill, "timestamp", "created_at"),
        "created_at": _val(bill, "created_at", "timestamp"),
        "items": [
            {
                "product_id": _val(it, "productid", "productId", "product_id"),
                "quantity": _val(it, "quantity", default=0),
                "unit_price": _val(it, "unitprice", "price", "unit_price", default=0),
                "item_total": _val(it, "itemtotal", "total", "item_total", default=0),
                "tax_percentage": _val(it, "tax_percentage", "taxPercentage", default=0),
                "hsn_code": _val(it, "hsn_code", "hsnCode", default=""),
                "name": _val(it, "name", default=""),
                "barcode": _val(it, "barcode", "barcodes", default=""),
            }
            for it in items
        ],
    }


def _exists_in_cloud(supabase, bill_id):
    try:
        resp = supabase.table("bills").select("id").eq("id", bill_id).limit(1).execute()
        return bool(resp.data)
    except Exception as e:
        # If we cannot verify, treat as "unknown" and skip to stay safe.
        print(f"  ! could not verify {bill_id} in cloud: {e}")
        return None


def run(apply: bool, limit: int, store: str):
    supabase = get_supabase_client()
    if getattr(supabase, "is_offline_fallback", False):
        print("ABORT: Supabase is offline. Run this while the machine is online.")
        return 1

    bills = read_json_file(BILLS_FILE, [])
    if not isinstance(bills, list):
        print("No bills.json list found; nothing to do.")
        return 0
    items_map = _items_by_bill()

    missing, recovered, skipped_existing, no_items, errors = [], [], 0, [], []

    for bill in bills:
        if not isinstance(bill, dict):
            continue
        bill_id = str(_val(bill, "id", default="")).strip()
        if not bill_id:
            continue
        if store and str(_val(bill, "storeid", "storeId", default="")) != store:
            continue
        if str(_val(bill, "status", default="completed")).lower() == "cancelled":
            continue

        exists = _exists_in_cloud(supabase, bill_id)
        if exists is None:
            continue
        if exists:
            skipped_existing += 1
            continue

        items = items_map.get(bill_id, [])
        if not items:
            no_items.append(bill_id)
            continue

        missing.append(bill_id)
        if len(missing) > limit:
            break

        if not apply:
            print(f"  WOULD RECOVER {bill_id}  ({len(items)} items, total={_val(bill, 'total', default='?')})")
            continue

        try:
            payload = _build_payload(bill, items)
            user_id = _val(bill, "userid", "createdby", "createdBy")
            create_bill_transaction(current_user_id=user_id, data=payload, forced_bill_id=bill_id)
            recovered.append(bill_id)
            print(f"  RECOVERED {bill_id}")
        except Exception as e:
            errors.append((bill_id, str(e)))
            print(f"  ERROR recovering {bill_id}: {e}")

    print("\n==== Recovery summary ====")
    print(f"Local bills scanned        : {len(bills)}")
    print(f"Already in cloud (skipped) : {skipped_existing}")
    print(f"Missing from cloud         : {len(missing)}")
    print(f"Recovered (this run)       : {len(recovered)}")
    print(f"Missing but NO local items : {len(no_items)}  (need manual review / re-entry)")
    if no_items:
        print("   " + ", ".join(no_items[:50]) + (" ..." if len(no_items) > 50 else ""))
    print(f"Errors                     : {len(errors)}")
    for bid, err in errors[:50]:
        print(f"   {bid}: {err}")
    if not apply:
        print("\nDRY RUN only. Re-run with --apply to perform recovery.")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Recover stranded offline bills into Supabase.")
    parser.add_argument("--apply", action="store_true", help="Actually create missing bills (default: dry run).")
    parser.add_argument("--limit", type=int, default=1000, help="Max bills to recover in one run.")
    parser.add_argument("--store", type=str, default="", help="Only process this store_id.")
    args = parser.parse_args()

    # create_bill_transaction's helpers log via flask.current_app; provide a context.
    try:
        from main import app
        with app.app_context():
            return run(apply=args.apply, limit=args.limit, store=args.store)
    except ImportError:
        # Fallback: run without the full app (logging-only helpers may warn).
        return run(apply=args.apply, limit=args.limit, store=args.store)


if __name__ == "__main__":
    raise SystemExit(main())
