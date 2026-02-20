import uuid
from datetime import datetime, timezone
from typing import Dict, Any, Optional

from utils.connection_pool import get_supabase_client
from data_access.data_access import update_both_inventory_and_product_stock
from utils.stock_stream import publish
from utils.discount_approval_cache import pop_discount_approval

DEFAULT_WALKIN_CUSTOMER_ID = "CUST-1754821420265"


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

    bill_id = forced_bill_id or f"BILL-{uuid.uuid4().hex[:12]}"
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

            status = discount_response.data[0].get("status")
            if status != "approved":
                # Check for a deferred approval cached during OTP verification
                if not deferred_discount_approval:
                    deferred_discount_approval = pop_discount_approval(current_user_id)

                if deferred_discount_approval:
                    try:
                        supabase.table("discounts").update(
                            {
                                "status": "approved",
                                "approved_by": deferred_discount_approval.get("approved_by"),
                                "updated_at": now,
                            }
                        ).eq("discount_id", discount_request_id).execute()
                    except Exception:
                        # Best-effort; fallback to strict check below if update fails
                        pass

                    # Re-fetch to confirm status
                    discount_response = (
                        supabase.table("discounts")
                        .select("status")
                        .eq("discount_id", discount_request_id)
                        .limit(1)
                        .execute()
                    )
                    status = discount_response.data[0].get("status") if discount_response.data else status

                if status != "approved":
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

    response = supabase.table("bills").insert(bill_data).execute()
    if not response.data or len(response.data) == 0:
        raise RuntimeError("Bill insert failed")

    created_bill = response.data[0]

    if discount_request_id:
        try:
            update_payload = {"bill_id": bill_id, "updated_at": now}
            if deferred_discount_approval:
                update_payload.update(
                    {
                        "status": "approved",
                        "approved_by": deferred_discount_approval.get("approved_by"),
                    }
                )

            (
                supabase.table("discounts")
                .update(update_payload)
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

    if len(bill_items_created) == 0:
        raise RuntimeError(
            f"Bill created but no bill items were saved. Errors: {bill_item_errors or ['unknown']}"
        )

    if updated_product_ids:
        publish(
            {
                "type": "stock_update",
                "store_id": store_id,
                "product_ids": updated_product_ids,
                "ts": datetime.now(timezone.utc).isoformat(),
            }
        )

    response_data = {
        "message": "Bill created successfully",
        "bill_id": bill_id,
        "bill": created_bill,
        "items_created": len(bill_items_created),
        "total_amount": data["total_amount"],
    }

    if bill_item_errors:
        response_data["bill_item_errors"] = bill_item_errors
    if stock_update_errors:
        response_data["stock_update_errors"] = stock_update_errors
        response_data["warning"] = f"Stock update failed for {len(stock_update_errors)} products"

    return response_data
