import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from config.config import (
    BILL_FORMATS_FILE,
    BILLS_FILE,
    CUSTOMERS_FILE,
    HSN_CODES_FILE,
    JSON_DIR,
    PRODUCTS_FILE,
    RETURNS_FILE,
    STORE_DAMAGE_RETURNS_FILE,
    STOREINVENTORY_FILE,
    STORES_FILE,
    SYSTEM_SETTINGS_FILE,
    USER_STORES_FILE,
    USERS_FILE,
)
from helpers.utils import read_json_file, write_json_file


TABLE_FILE_MAP = {
    "users": USERS_FILE,
    "products": PRODUCTS_FILE,
    "bills": BILLS_FILE,
    "billitems": os.path.join(JSON_DIR, "billitems.json"),
    "customers": CUSTOMERS_FILE,
    "stores": STORES_FILE,
    "systemsettings": SYSTEM_SETTINGS_FILE,
    "returns": RETURNS_FILE,
    "store_damage_returns": STORE_DAMAGE_RETURNS_FILE,
    "billformats": BILL_FORMATS_FILE,
    "userstores": USER_STORES_FILE,
    "storeinventory": STOREINVENTORY_FILE,
    "notifications": os.path.join(JSON_DIR, "notifications.json"),
    "discounts": os.path.join(JSON_DIR, "discounts.json"),
    "hsn_codes": HSN_CODES_FILE,
    "two_factor": os.path.join(JSON_DIR, "two_factor.json"),
    "replacements": os.path.join(JSON_DIR, "replacements.json"),
    "inventory_transfer_orders": os.path.join(JSON_DIR, "inventory_transfer_orders.json"),
    "inventory_transfer_items": os.path.join(JSON_DIR, "inventory_transfer_items.json"),
    "inventory_transfer_scans": os.path.join(JSON_DIR, "inventory_transfer_scans.json"),
    "inventory_transfer_verifications": os.path.join(JSON_DIR, "inventory_transfer_verifications.json"),
    "damaged_inventory_events": os.path.join(JSON_DIR, "damaged_inventory_events.json"),
    "sync_table": os.path.join(JSON_DIR, "sync_table.json"),
    "app_config": os.path.join(JSON_DIR, "app_config.json"),
}


@dataclass
class LocalResponse:
    data: List[Dict[str, Any]]
    count: Optional[int] = None
    status_code: int = 200
    error: Optional[str] = None

    def json(self) -> Dict[str, Any]:
        return {"data": self.data, "count": self.count, "error": self.error}


class OfflineSupabaseQuery:
    def __init__(self, table_name: str):
        self.table_name = table_name.lower()
        self._filters: List[Tuple[str, str, Any]] = []
        self._or_clause: Optional[str] = None
        self._limit: Optional[int] = None
        self._order_by: Optional[Tuple[str, bool]] = None
        self._op: str = "select"
        self._payload: Any = None
        self._want_count: bool = False

    def select(self, *_args, count: Optional[str] = None, **_kwargs):
        self._op = "select"
        self._want_count = count == "exact"
        return self

    def insert(self, payload: Any):
        self._op = "insert"
        self._payload = payload
        return self

    def upsert(self, payload: Any):
        self._op = "upsert"
        self._payload = payload
        return self

    def update(self, payload: Dict[str, Any]):
        self._op = "update"
        self._payload = payload or {}
        return self

    def delete(self):
        self._op = "delete"
        return self

    def eq(self, column: str, value: Any):
        self._filters.append(("eq", column, value))
        return self

    def neq(self, column: str, value: Any):
        self._filters.append(("neq", column, value))
        return self

    def gte(self, column: str, value: Any):
        self._filters.append(("gte", column, value))
        return self

    def lte(self, column: str, value: Any):
        self._filters.append(("lte", column, value))
        return self

    def in_(self, column: str, values: List[Any]):
        self._filters.append(("in", column, values))
        return self

    def ilike(self, column: str, pattern: str):
        self._filters.append(("ilike", column, pattern))
        return self

    def or_(self, clause: str):
        self._or_clause = clause
        return self

    def order(self, column: str, desc: bool = False):
        self._order_by = (column, bool(desc))
        return self

    def limit(self, value: int):
        self._limit = int(value)
        return self

    def execute(self) -> LocalResponse:
        rows = self._load_rows()
        if self._op == "select":
            matched = self._apply_filters(rows)
            total = len(matched)
            if self._order_by:
                col, desc = self._order_by
                matched.sort(key=lambda row: str(row.get(col, "")), reverse=desc)
            if self._limit is not None:
                matched = matched[: self._limit]
            return LocalResponse(data=matched, count=total if self._want_count else None)

        if self._op == "insert":
            new_rows = self._normalize_payload(self._payload)
            for row in new_rows:
                row.setdefault("id", str(uuid.uuid4()))
                row.setdefault("created_at", time.strftime("%Y-%m-%dT%H:%M:%S"))
                row.setdefault("updated_at", time.strftime("%Y-%m-%dT%H:%M:%S"))
                rows.append(row)
            self._save_rows(rows)
            return LocalResponse(data=new_rows)

        if self._op == "upsert":
            upsert_rows = self._normalize_payload(self._payload)
            indexed = {str(r.get("id")): i for i, r in enumerate(rows) if r.get("id") is not None}
            result_rows: List[Dict[str, Any]] = []
            for row in upsert_rows:
                row_id = str(row.get("id") or str(uuid.uuid4()))
                row["id"] = row_id
                row["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                if row_id in indexed:
                    rows[indexed[row_id]].update(row)
                    result_rows.append(rows[indexed[row_id]])
                else:
                    row.setdefault("created_at", row["updated_at"])
                    rows.append(row)
                    result_rows.append(row)
            self._save_rows(rows)
            return LocalResponse(data=result_rows)

        matched_idx = [i for i, row in enumerate(rows) if self._matches(row)]
        if self._op == "update":
            updated_rows: List[Dict[str, Any]] = []
            for i in matched_idx:
                rows[i].update(self._payload or {})
                if "updated_at" not in (self._payload or {}):
                    rows[i]["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                updated_rows.append(rows[i])
            self._save_rows(rows)
            return LocalResponse(data=updated_rows)

        if self._op == "delete":
            deleted_rows = [rows[i] for i in matched_idx]
            remaining = [row for i, row in enumerate(rows) if i not in set(matched_idx)]
            self._save_rows(remaining)
            return LocalResponse(data=deleted_rows)

        return LocalResponse(data=[])

    def _path(self) -> str:
        return TABLE_FILE_MAP.get(self.table_name, os.path.join(JSON_DIR, f"{self.table_name}.json"))

    def _load_rows(self) -> List[Dict[str, Any]]:
        data = read_json_file(self._path(), [])
        if isinstance(data, dict):
            return [data]
        return data if isinstance(data, list) else []

    def _save_rows(self, rows: List[Dict[str, Any]]) -> None:
        write_json_file(self._path(), rows)

    @staticmethod
    def _normalize_payload(payload: Any) -> List[Dict[str, Any]]:
        if payload is None:
            return []
        if isinstance(payload, list):
            return [row for row in payload if isinstance(row, dict)]
        if isinstance(payload, dict):
            return [payload]
        return []

    def _apply_filters(self, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        filtered = [row for row in rows if self._matches(row)]
        if not self._or_clause:
            return filtered
        return [row for row in filtered if self._matches_or_clause(row)]

    def _matches(self, row: Dict[str, Any]) -> bool:
        for op, column, value in self._filters:
            row_value = row.get(column)
            if op == "eq" and str(row_value) != str(value):
                return False
            if op == "neq" and str(row_value) == str(value):
                return False
            if op == "gte" and str(row_value) < str(value):
                return False
            if op == "lte" and str(row_value) > str(value):
                return False
            if op == "in":
                allowed = {str(v) for v in (value or [])}
                if str(row_value) not in allowed:
                    return False
            if op == "ilike":
                needle = str(value or "").replace("%", "").lower()
                haystack = str(row_value or "").lower()
                if needle not in haystack:
                    return False
        return True

    def _matches_or_clause(self, row: Dict[str, Any]) -> bool:
        parts = [p.strip() for p in (self._or_clause or "").split(",") if p.strip()]
        for part in parts:
            tokens = part.split(".")
            if len(tokens) < 3:
                continue
            column = tokens[0]
            op = tokens[1]
            value = ".".join(tokens[2:])
            if op == "ilike":
                needle = value.replace("%", "").lower()
                if needle in str(row.get(column, "")).lower():
                    return True
            elif op == "eq":
                if str(row.get(column)) == value:
                    return True
        return False


class OfflineSupabaseClient:
    is_offline_fallback = True

    def table(self, table_name: str) -> OfflineSupabaseQuery:
        return OfflineSupabaseQuery(table_name)

    def from_(self, table_name: str) -> OfflineSupabaseQuery:
        return OfflineSupabaseQuery(table_name)

