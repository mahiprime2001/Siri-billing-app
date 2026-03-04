import uuid
from datetime import datetime, timezone
from typing import Dict, Any, Optional
import re
from zoneinfo import ZoneInfo

from utils.connection_pool import get_supabase_client
from data_access.data_access import update_both_inventory_and_product_stock
from utils.stock_stream import publish
from utils.discount_approval_cache import pop_discount_approval

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
    if not supabase:
        raise RuntimeError("Supabase client unavailable")

    bill_id = _generate_daily_invoice_id(supabase)
    now = datetime.now(timezone.utc).isoformat()
    customer_id = data.get("customer_id") or DEFAULT_WALKIN_CUSTOMER_ID

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
        "timestamp": now,
        "status": "completed",
        "createdby": current_user_id,
        "created_at": now,
        "updated_at": now,
    }

    response = None
    for _ in range(5):
        try:
            response = supabase.table("bills").insert(bill_data).execute()
            if response.data and len(response.data) > 0:
                break
        except Exception as insert_error:
            err_text = str(insert_error).lower()
            if "duplicate" in err_text or "unique" in err_text:
                bill_id = _generate_daily_invoice_id(supabase)
                bill_data["id"] = bill_id
                continue
            raise

    if not response or not response.data or len(response.data) == 0:
        raise RuntimeError("Bill insert failed")

    created_bill = response.data[0]

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

    bill_items_created = []
    bill_item_errors = []
    stock_update_errors = []
    updated_product_ids = []
    replacement_save_errors = []
    replacement_stock_errors = []
    replacement_rows_created = 0

    for index, item in enumerate(items):
        product_id = item.get("product_id") or item.get("productId")
        quantity = item.get("quantity", 1)
        unit_price = item.get("unit_price", item.get("unitPrice", item.get("price", 0)))
        item_total = item.get("item_total", item.get("itemTotal", unit_price * quantity))

        if not product_id:
            bill_item_errors.append(f"item[{index}] missing product_id/productId")
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
            if item_response.data:
                bill_items_created.append(product_id)
            else:
                bill_item_errors.append(f"item[{index}] empty insert response for product {product_id}")
        except Exception as item_error:
            bill_item_errors.append(f"item[{index}] insert error for product {product_id}: {str(item_error)}")

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

    if len(bill_items_created) == 0:
        raise RuntimeError(
            f"Bill created but no bill items were saved. Errors: {bill_item_errors or ['unknown']}"
        )

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
