import uuid
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List
import re
from zoneinfo import ZoneInfo

from utils.connection_pool import get_supabase_client
from data_access.data_access import update_both_inventory_and_product_stock
from utils.stock_stream import publish
from utils.discount_approval_cache import pop_discount_approval
from utils.bill_item_snapshot import replace_bill_item_snapshots, delete_bill_item_snapshots

DEFAULT_WALKIN_CUSTOMER_ID = "CUST-1754821420265"
INVOICE_ID_REGEX = re.compile(r"^INV-(\d{8})(\d{4})$")
IST_ZONE = ZoneInfo("Asia/Kolkata")


def _get_today_invoice_prefix() -> str:
    return f"INV-{datetime.now(IST_ZONE).strftime('%d%m%Y')}"


def _extract_serial_for_prefix(invoice_id: Optional[str], prefix: str) -> int:
    if not invoice_id or not invoice_id.startswith(prefix):
        return 0
    match = INVOICE_ID_REGEX.match(invoice_id)
    if not match:
        return 0
    try:
        return int(match.group(2))
    except (TypeError, ValueError):
        return 0


def _generate_daily_invoice_id(supabase) -> str:
    prefix = _get_today_invoice_prefix()
    max_serial = 0

    try:
        response = (
            supabase.table("bills")
            .select("id")
            .like("id", f"{prefix}%")
            .execute()
        )
        for row in (response.data or []):
            max_serial = max(max_serial, _extract_serial_for_prefix(str(row.get("id") or ""), prefix))
    except Exception:
        # If lookup fails, fallback to first serial for today.
        pass

    return f"{prefix}{max_serial + 1:04d}"


def _fetch_existing_bill_by_id(supabase, bill_id: str) -> Optional[Dict[str, Any]]:
    try:
        response = (
            supabase.table("bills")
            .select("*")
            .eq("id", bill_id)
            .limit(1)
            .execute()
        )
        if response.data:
            return response.data[0]
    except Exception:
        return None
    return None


def _bill_has_items(supabase, bill_id: str) -> bool:
    try:
        response = (
            supabase.table("billitems")
            .select("id")
            .eq("billid", bill_id)
            .limit(1)
            .execute()
        )
        return bool(response.data)
    except Exception:
        return False


def _parse_positive_int(value: Any, default: int = 0) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed


def _parse_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _normalize_event_time(value: Any) -> Optional[str]:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        normalized = raw.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        # bills.timestamp is stored as "timestamp without time zone" in Supabase.
        # Keep the IST wall-clock value to avoid UTC-shifted invoice times.
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=IST_ZONE)
        else:
            dt = dt.astimezone(IST_ZONE)
        return dt.replace(tzinfo=None).isoformat(timespec="milliseconds")
    except Exception:
        return None


def _fetch_product_snapshot_map(supabase, product_ids):
    clean_ids = [str(pid) for pid in product_ids if pid]
    if not clean_ids:
        return {}

    response = (
        supabase.table("products")
        .select("id, name, barcode, hsn_code_id, hsn_codes(hsn_code, tax)")
        .in_("id", clean_ids)
        .execute()
    )

    snapshot_map = {}
    for row in (response.data or []):
        hsn_ref = row.get("hsn_codes")
        if isinstance(hsn_ref, list):
            hsn_ref = hsn_ref[0] if hsn_ref else {}
        if not isinstance(hsn_ref, dict):
            hsn_ref = {}

        product_id = str(row.get("id") or "").strip()
        if not product_id:
            continue
        snapshot_map[product_id] = {
            "name": row.get("name") or "",
            "barcode": row.get("barcode") or "",
            "hsn_code": (hsn_ref.get("hsn_code") or ""),
            "tax_percentage": _parse_float(hsn_ref.get("tax"), 0.0),
        }
    return snapshot_map


def _aggregate_item_quantities(items):
    aggregated = {}
    for index, item in enumerate(items):
        product_id = item.get("product_id") or item.get("productId")
        quantity = _parse_positive_int(item.get("quantity", 1), default=0)
        if not product_id:
            raise ValueError(f"item[{index}] missing product_id/productId")
        if quantity <= 0:
            raise ValueError(f"item[{index}] has invalid quantity")
        aggregated[product_id] = aggregated.get(product_id, 0) + quantity
    return aggregated


def _fetch_store_stock_map(supabase, store_id: str, product_ids):
    if not product_ids:
        return {}
    response = (
        supabase.table("storeinventory")
        .select("productid, quantity")
        .eq("storeid", store_id)
        .in_("productid", list(product_ids))
        .execute()
    )
    stock_map = {}
    for row in (response.data or []):
        product_id = row.get("productid")
        if not product_id:
            continue
        stock_map[product_id] = _parse_positive_int(row.get("quantity"), default=0)
    return stock_map


def _validate_sufficient_stock(supabase, store_id: str, required_quantities):
    stock_map = _fetch_store_stock_map(supabase, store_id, required_quantities.keys())
    stock_errors = []
    for product_id, required_qty in required_quantities.items():
        available_qty = _parse_positive_int(stock_map.get(product_id), default=0)
        if required_qty > available_qty:
            stock_errors.append(
                f"{product_id}: required={required_qty}, available={available_qty}"
            )
    return stock_errors


def _rollback_bill_creation(supabase, bill_id: str, store_id: str, applied_deductions):
    rollback_errors = []

    for product_id, quantity in applied_deductions:
        try:
            restored = update_both_inventory_and_product_stock(
                store_id=store_id,
                product_id=product_id,
                quantity_sold=-quantity,
            )
            if not restored:
                rollback_errors.append(f"stock restore failed for {product_id}")
        except Exception as restore_error:
            rollback_errors.append(f"stock restore error for {product_id}: {restore_error}")

    try:
        supabase.table("replacements").delete().eq("bill_id", bill_id).execute()
    except Exception as replacement_delete_error:
        rollback_errors.append(f"replacement cleanup failed: {replacement_delete_error}")

    try:
        supabase.table("billitems").delete().eq("billid", bill_id).execute()
    except Exception as item_delete_error:
        rollback_errors.append(f"billitems cleanup failed: {item_delete_error}")

    try:
        supabase.table("bills").delete().eq("id", bill_id).execute()
    except Exception as bill_delete_error:
        rollback_errors.append(f"bill cleanup failed: {bill_delete_error}")

    return rollback_errors


def create_bill_transaction(
    current_user_id: str,
    data: Dict[str, Any],
    forced_bill_id: Optional[str] = None,
) -> Dict[str, Any]:
    required_fields = ["store_id", "items", "total_amount"]
    if not all(field in data for field in required_fields):
        missing = [f for f in required_fields if f not in data]
        raise ValueError(f"Missing required fields: {missing}")

    store_id = data["store_id"]
    items = data["items"]
    if not items or len(items) == 0:
        raise ValueError("Items list is empty")

    supabase = get_supabase_client()
    if not supabase or getattr(supabase, "is_offline_fallback", False):
        raise RuntimeError("Supabase client unavailable")

    bill_id = forced_bill_id or _generate_daily_invoice_id(supabase)
    now = datetime.now(timezone.utc).isoformat()
    local_now = datetime.now(IST_ZONE).replace(tzinfo=None).isoformat(timespec="milliseconds")
    bill_event_time = (
        _normalize_event_time(data.get("timestamp"))
        or _normalize_event_time(data.get("created_at"))
        or local_now
    )
    customer_id = data.get("customer_id") or DEFAULT_WALKIN_CUSTOMER_ID
    created_bill = None
    skip_bill_insert = False

    if forced_bill_id:
        existing_bill = _fetch_existing_bill_by_id(supabase, forced_bill_id)
        if existing_bill:
            if _bill_has_items(supabase, forced_bill_id):
                return {
                    "message": "Bill already exists",
                    "bill_id": forced_bill_id,
                    "bill": existing_bill,
                    "items_created": 0,
                    "total_amount": data.get("total_amount", 0),
                    "idempotent_replay": True,
                }
            created_bill = existing_bill
            skip_bill_insert = True

    discount_percentage = data.get("discount_percentage", 0) or 0
    discount_amount = data.get("discount_amount", 0) or 0
    discount_request_id = data.get("discount_request_id")
    deferred_discount_approval = data.get("_deferred_discount_approval")

    if discount_percentage > 10:
        if discount_request_id:
            discount_response = (
                supabase.table("discounts")
                .select("status")
                .eq("discount_id", discount_request_id)
                .limit(1)
                .execute()
            )
            if not discount_response.data:
                raise ValueError("Discount request not found")
            if discount_response.data[0].get("status") != "approved":
                raise ValueError("Discount request not approved")
        else:
            if not deferred_discount_approval:
                deferred_discount_approval = pop_discount_approval(current_user_id)
            if not deferred_discount_approval:
                raise ValueError("Discount OTP verification required for discounts above 10%")

    bill_data = {
        "id": bill_id,
        "storeid": store_id,
        "customerid": customer_id,
        "userid": current_user_id,
        "subtotal": data.get("subtotal", data["total_amount"]),
        "discount_percentage": data.get("discount_percentage", 0),
        "discount_amount": discount_amount,
        "total": data["total_amount"],
        "paymentmethod": data.get("payment_method", "cash"),
        "timestamp": bill_event_time,
        "status": "completed",
        "createdby": current_user_id,
        "created_at": bill_event_time,
        "updated_at": now,
    }

    response = None
    if not skip_bill_insert:
        for _ in range(5):
            try:
                response = supabase.table("bills").insert(bill_data).execute()
                if response.data and len(response.data) > 0:
                    created_bill = response.data[0]
                    break
                # Some PostgREST configs can return empty data even on success.
                created_bill = _fetch_existing_bill_by_id(supabase, bill_data["id"])
                if created_bill:
                    break
            except Exception as insert_error:
                err_text = str(insert_error).lower()
                if "duplicate" in err_text or "unique" in err_text:
                    if forced_bill_id:
                        existing_bill = _fetch_existing_bill_by_id(supabase, forced_bill_id)
                        if existing_bill and _bill_has_items(supabase, forced_bill_id):
                            return {
                                "message": "Bill already exists",
                                "bill_id": forced_bill_id,
                                "bill": existing_bill,
                                "items_created": 0,
                                "total_amount": data.get("total_amount", 0),
                                "idempotent_replay": True,
                            }
                    bill_id = _generate_daily_invoice_id(supabase)
                    bill_data["id"] = bill_id
                    continue
                raise

    if not created_bill:
        raise RuntimeError("Bill insert failed")

    if discount_request_id:
        try:
            (
                supabase.table("discounts")
                .update({"bill_id": bill_id, "updated_at": now})
                .eq("discount_id", discount_request_id)
                .execute()
            )
        except Exception:
            pass
    elif discount_percentage > 10 and deferred_discount_approval:
        try:
            supabase.table("discounts").insert(
                {
                    "discount_id": f"DISC-{uuid.uuid4().hex[:12]}",
                    "user_id": current_user_id,
                    "discount": discount_percentage,
                    "discount_amount": discount_amount,
                    "bill_id": bill_id,
                    "status": "approved",
                    "approved_by": deferred_discount_approval.get("approved_by"),
                    "created_at": now,
                    "updated_at": now,
                }
            ).execute()
        except Exception:
            pass

    required_quantities = _aggregate_item_quantities(items)
    insufficient_stock_errors = _validate_sufficient_stock(
        supabase=supabase,
        store_id=store_id,
        required_quantities=required_quantities,
    )
    if insufficient_stock_errors:
        raise ValueError(
            "Insufficient stock for one or more products: "
            + "; ".join(insufficient_stock_errors)
        )

    bill_items_created = []
    bill_item_errors = []
    stock_update_errors = []
    updated_product_ids = []
    applied_stock_deductions = []
    replacement_save_errors = []
    replacement_stock_errors = []
    replacement_rows_created = 0
    product_snapshot_map = _fetch_product_snapshot_map(supabase, required_quantities.keys())
    item_snapshots_for_bill: List[Dict[str, Any]] = []

    for index, item in enumerate(items):
        product_id = item.get("product_id") or item.get("productId")
        quantity = _parse_positive_int(item.get("quantity", 1), default=0)
        unit_price = item.get("unit_price", item.get("unitPrice", item.get("price", 0)))
        item_total = item.get("item_total", item.get("itemTotal", unit_price * quantity))

        if not product_id:
            bill_item_errors.append(f"item[{index}] missing product_id/productId")
            continue
        if quantity <= 0:
            bill_item_errors.append(f"item[{index}] has invalid quantity")
            continue

        bill_item_data = {
            "billid": bill_id,
            "productid": product_id,
            "quantity": quantity,
            "price": unit_price,
            "total": item_total,
            "created_at": now,
            "updated_at": now,
        }

        try:
            item_response = supabase.table("billitems").insert(bill_item_data).execute()
            _ = item_response
            bill_items_created.append(product_id)

            source_tax = item.get("tax_percentage", item.get("taxPercentage"))
            source_hsn = item.get("hsn_code", item.get("hsnCode"))
            source_name = item.get("name", "")
            source_barcode = item.get("barcode", item.get("barcodes", ""))
            product_snapshot = product_snapshot_map.get(str(product_id), {})

            item_snapshots_for_bill.append(
                {
                    "productid": product_id,
                    "quantity": quantity,
                    "price": _parse_float(unit_price, 0.0),
                    "total": _parse_float(item_total, 0.0),
                    "tax_percentage": _parse_float(
                        source_tax if source_tax is not None else product_snapshot.get("tax_percentage"),
                        0.0,
                    ),
                    "hsn_code": str(source_hsn or product_snapshot.get("hsn_code") or "").strip(),
                    "name": str(source_name or product_snapshot.get("name") or "").strip(),
                    "barcode": str(source_barcode or product_snapshot.get("barcode") or "").strip(),
                    "created_at": now,
                }
            )
        except Exception as item_error:
            bill_item_errors.append(f"item[{index}] insert error for product {product_id}: {str(item_error)}")
            continue

        try:
            stock_updated = update_both_inventory_and_product_stock(
                store_id=store_id,
                product_id=product_id,
                quantity_sold=quantity,
            )
            if not stock_updated:
                stock_update_errors.append(product_id)
            else:
                updated_product_ids.append(product_id)
                applied_stock_deductions.append((product_id, quantity))
        except Exception:
            stock_update_errors.append(product_id)

    replacements = data.get("replacements", []) or []
    for index, replacement in enumerate(replacements):
        replaced_product_id = replacement.get("replaced_product_id")
        new_product_id = replacement.get("new_product_id")
        quantity = int(replacement.get("quantity", 0) or 0)
        price = float(replacement.get("price", 0) or 0)
        final_amount = float(replacement.get("final_amount", 0) or 0)
        damaged_qty = int(replacement.get("damaged_qty", 0) or 0)
        damage_reason = replacement.get("damage_reason")
        is_damaged = bool(replacement.get("is_damaged")) or damaged_qty > 0
        original_bill_id = replacement.get("original_bill_id") or data.get("original_bill_id")

        if not replaced_product_id or not new_product_id or quantity <= 0:
            replacement_save_errors.append(f"replacement[{index}] invalid payload")
            continue

        if is_damaged or damage_reason:
            replacement_save_errors.append(
                f"replacement[{index}] damaged flow is not allowed in replacement"
            )
            continue

        replacement_id = f"REP-{uuid.uuid4().hex[:12].upper()}"
        replacement_payload = {
            "id": replacement_id,
            "bill_id": bill_id,
            "original_bill_id": original_bill_id,
            "replaced_product_id": replaced_product_id,
            "new_product_id": new_product_id,
            "quantity": quantity,
            "price": price,
            "final_amount": final_amount,
            "is_damaged": False,
            "damaged_qty": 0,
            "damage_reason": None,
            "store_id": store_id,
            "user_id": current_user_id,
            "created_at": now,
            "updated_at": now,
        }

        try:
            replacement_insert = supabase.table("replacements").insert(replacement_payload).execute()
            if replacement_insert.data:
                replacement_rows_created += 1
            else:
                replacement_save_errors.append(f"replacement[{index}] insert returned empty response")
        except Exception as replacement_error:
            replacement_save_errors.append(f"replacement[{index}] insert error: {str(replacement_error)}")

        # Entire replaced quantity is restocked in replacement flow.
        restock_qty = max(0, quantity)
        if restock_qty > 0:
            try:
                restored = update_both_inventory_and_product_stock(
                    store_id=store_id,
                    product_id=replaced_product_id,
                    quantity_sold=-restock_qty,
                )
                if restored:
                    updated_product_ids.append(replaced_product_id)
                else:
                    replacement_stock_errors.append(replaced_product_id)
            except Exception:
                replacement_stock_errors.append(replaced_product_id)

    has_blocking_errors = bool(
        bill_item_errors or stock_update_errors or replacement_save_errors or replacement_stock_errors
    )
    if has_blocking_errors or len(bill_items_created) == 0:
        rollback_errors = _rollback_bill_creation(
            supabase=supabase,
            bill_id=bill_id,
            store_id=store_id,
            applied_deductions=applied_stock_deductions,
        )
        try:
            delete_bill_item_snapshots(bill_id)
        except Exception:
            pass
        failure_parts = []
        if bill_item_errors:
            failure_parts.append(f"bill item errors: {bill_item_errors}")
        if stock_update_errors:
            failure_parts.append(f"stock update errors: {stock_update_errors}")
        if replacement_save_errors:
            failure_parts.append(f"replacement save errors: {replacement_save_errors}")
        if replacement_stock_errors:
            failure_parts.append(f"replacement stock errors: {replacement_stock_errors}")
        if len(bill_items_created) == 0:
            failure_parts.append("no bill items were created")
        if rollback_errors:
            failure_parts.append(f"rollback errors: {rollback_errors}")
        raise ValueError("Bill creation failed and was rolled back. " + " | ".join(failure_parts))

    unique_updated_products = list(dict.fromkeys(updated_product_ids))
    if unique_updated_products:
        publish(
            {
                "type": "stock_update",
                "store_id": store_id,
                "product_ids": unique_updated_products,
                "ts": datetime.now(timezone.utc).isoformat(),
            }
        )

    try:
        replace_bill_item_snapshots(bill_id, item_snapshots_for_bill)
    except Exception:
        # Snapshot persistence is best-effort and should not block billing.
        pass

    response_data = {
        "message": "Bill created successfully",
        "bill_id": bill_id,
        "bill": created_bill,
        "items_created": len(bill_items_created),
        "total_amount": data["total_amount"],
        "replacements_created": replacement_rows_created,
    }

    if bill_item_errors:
        response_data["bill_item_errors"] = bill_item_errors
    if stock_update_errors:
        response_data["stock_update_errors"] = stock_update_errors
        response_data["warning"] = f"Stock update failed for {len(stock_update_errors)} products"
    if replacement_save_errors:
        response_data["replacement_save_errors"] = replacement_save_errors
    if replacement_stock_errors:
        response_data["replacement_stock_errors"] = replacement_stock_errors

    return response_data
