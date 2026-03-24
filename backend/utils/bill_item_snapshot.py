from datetime import datetime, timezone
from typing import Any, Dict, List

from config.config import BILL_ITEM_SNAPSHOTS_FILE
from helpers.utils import read_json_file, write_json_file


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def normalize_snapshot_row(bill_id: str, raw: Dict[str, Any]) -> Dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "billid": str(bill_id),
        "productid": str(raw.get("productid") or raw.get("product_id") or ""),
        "quantity": _to_int(raw.get("quantity"), 0),
        "price": _to_float(raw.get("price"), 0.0),
        "total": _to_float(raw.get("total"), 0.0),
        "tax_percentage": _to_float(raw.get("tax_percentage"), 0.0),
        "hsn_code": str(raw.get("hsn_code") or "").strip(),
        "name": str(raw.get("name") or "").strip(),
        "barcode": str(raw.get("barcode") or "").strip(),
        "created_at": str(raw.get("created_at") or now),
        "updated_at": now,
    }


def get_bill_item_snapshots(bill_id: str) -> List[Dict[str, Any]]:
    if not bill_id:
        return []
    rows = read_json_file(BILL_ITEM_SNAPSHOTS_FILE, [])
    if not isinstance(rows, list):
        return []
    return [row for row in rows if str(row.get("billid")) == str(bill_id)]


def replace_bill_item_snapshots(bill_id: str, rows: List[Dict[str, Any]]) -> None:
    existing = read_json_file(BILL_ITEM_SNAPSHOTS_FILE, [])
    if not isinstance(existing, list):
        existing = []

    kept = [row for row in existing if str(row.get("billid")) != str(bill_id)]
    normalized = [normalize_snapshot_row(bill_id, row or {}) for row in (rows or [])]
    write_json_file(BILL_ITEM_SNAPSHOTS_FILE, kept + normalized)


def delete_bill_item_snapshots(bill_id: str) -> None:
    existing = read_json_file(BILL_ITEM_SNAPSHOTS_FILE, [])
    if not isinstance(existing, list):
        existing = []
    kept = [row for row in existing if str(row.get("billid")) != str(bill_id)]
    write_json_file(BILL_ITEM_SNAPSHOTS_FILE, kept)
