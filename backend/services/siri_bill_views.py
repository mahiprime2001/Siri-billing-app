"""
Bill history and bill edit/cancel through siri-api (switch groups: bills_read, bills_write).

siri-api answers these from live product data. The old local routes also add this PC's own saved tax/HSN/name detail
for each bill line (utils/bill_item_snapshot.py, written when the bill was made) because that is what the receipt
was printed with, so these functions lay that detail over siri-api's answer before the screen sees it.
  * `overlay_items`         for GET /bills/<id>/items
  * `overlay_edit_payload`  for GET /bills/<id>/edit-payload
  * `after_revise`/`after_cancel`  small local follow-ups once siri-api has changed a bill (all best effort)
Nothing here may raise into a sale: a failed overlay makes the proxy fall back to the old route.
"""
import logging
from typing import Any, Dict, List, Tuple

from flask import request

logger = logging.getLogger("main")


def _bill_id() -> str:
    return str((request.view_args or {}).get("bill_id") or "")


def _buckets(bill_id: str):
    # the same matching rules as the old routes (exact product/qty/price/total first, then product/qty)
    from routes.billing_routes import _build_snapshot_buckets
    from utils.bill_item_snapshot import get_bill_item_snapshots
    return _build_snapshot_buckets(get_bill_item_snapshots(bill_id))


def _pop(buckets, productid, quantity, price, total):
    from routes.billing_routes import _pop_item_snapshot
    return _pop_item_snapshot(buckets, {"productid": productid, "quantity": quantity, "price": price, "total": total}) or {}


def overlay_items(status: int, body: Any) -> Tuple[int, Any]:
    if status != 200 or not isinstance(body, list):
        return status, body
    buckets = _buckets(_bill_id())
    for item in body:
        snap = _pop(buckets, item.get("productid"), item.get("quantity"), item.get("price"), item.get("total"))
        if not snap:
            continue
        product = item.get("products") if isinstance(item.get("products"), dict) else {}
        hsn = snap.get("hsn_code")
        if hsn:
            item["hsn_code"] = item["hsnCode"] = hsn
        if snap.get("tax_percentage") is not None:
            item["tax_percentage"] = item["taxPercentage"] = snap["tax_percentage"]
            product["tax"] = snap["tax_percentage"]
        if snap.get("name") and not product.get("name"):
            product["name"] = snap["name"]
        if snap.get("barcode") and not product.get("barcode"):
            product["barcode"] = snap["barcode"]
        item["products"] = product
    return status, body


def overlay_edit_payload(status: int, body: Any) -> Tuple[int, Any]:
    if status != 200 or not isinstance(body, dict) or not isinstance(body.get("items"), list):
        return status, body
    buckets = _buckets(_bill_id())
    for item in body["items"]:
        snap = _pop(buckets, item.get("productId"), item.get("quantity"), item.get("price"), item.get("total"))
        if not snap:
            continue
        if snap.get("tax_percentage") is not None:
            item["taxPercentage"] = float(snap["tax_percentage"] or 0)
        if snap.get("hsn_code"):
            item["hsnCode"] = snap["hsn_code"]
        if snap.get("name") and item.get("name") in (None, "", "Unknown Item"):
            item["name"] = snap["name"]
        if snap.get("barcode") and not item.get("barcodes"):
            item["barcodes"] = snap["barcode"]
    return status, body


def _num(*values, default=0.0) -> float:
    for v in values:
        try:
            if v not in (None, ""):
                return float(v)
        except (TypeError, ValueError):
            continue
    return default


def revised_snapshots(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The receipt detail for a revised bill's lines, from what the cashier sent (same line rules as siri-api)."""
    rows = []
    for src in (payload or {}).get("items") or []:
        if not isinstance(src, dict):
            continue
        pid = src.get("product_id") or src.get("productId")
        try:
            qty = int(src.get("quantity") or 0)
        except (TypeError, ValueError):
            qty = 0
        if not pid or qty <= 0:
            continue
        price = _num(src.get("unit_price"), src.get("unitPrice"), src.get("price"))
        total = _num(src.get("item_total"), src.get("itemTotal"), src.get("total"), default=0.0) or price * qty
        row = {"productid": str(pid), "quantity": qty, "price": price, "total": total,
               "name": str(src.get("name") or "").strip(),
               "barcode": str(src.get("barcode") or src.get("barcodes") or "").strip()}
        tax = src.get("tax_percentage", src.get("taxPercentage"))
        if tax is not None:
            row["tax_percentage"] = _num(tax)           # left out when unknown, so the live product tax shows
        hsn = str(src.get("hsn_code") or src.get("hsnCode") or "").strip()
        if hsn:
            row["hsn_code"] = hsn
        rows.append(row)
    return rows


def _stock_moved(store_id: str, product_ids) -> None:
    try:
        from utils.products_cache import invalidate_all_products_cache
        invalidate_all_products_cache()
    except Exception as e:  # noqa: BLE001
        logger.warning("SIRI_API bill change: could not refresh the product cache: %s", e)
    try:
        ids = [str(p) for p in dict.fromkeys(product_ids) if p]
        if store_id and ids:
            from datetime import datetime, timezone
            from utils.stock_stream import publish
            publish({"type": "stock_update", "store_id": store_id, "product_ids": ids,
                     "ts": datetime.now(timezone.utc).isoformat()})
    except Exception as e:  # noqa: BLE001
        logger.warning("SIRI_API bill change: could not announce the stock change: %s", e)


def after_revise(status: int, body: Any) -> None:
    payload = request.get_json(silent=True) or {}
    bill_id = _bill_id()
    try:
        from utils.bill_item_snapshot import replace_bill_item_snapshots
        replace_bill_item_snapshots(bill_id, revised_snapshots(payload))
    except Exception as e:  # noqa: BLE001
        logger.warning("SIRI_API revise %s: could not save the receipt detail locally: %s", bill_id, e)
    _stock_moved(str(payload.get("store_id") or ""), [i.get("product_id") or i.get("productId")
                                                       for i in payload.get("items") or [] if isinstance(i, dict)])


def after_cancel(status: int, body: Any) -> None:
    _stock_moved("", [])
