"""
Store -> Admin RETURN ORDERS.

A store scans products (picking a reason, then scanning the items under it) and
submits ONE return order: a `returns` row (return_type='store_to_admin') plus one
`return_products` line per product, each line carrying its own reason.

Stock is NOT reduced here — that happens when the admin verifies receipt.
"""
import uuid
import traceback
from datetime import datetime, timezone

from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity

from auth.auth import require_auth
from utils.connection_pool import get_supabase_client
from helpers.utils import read_json_file, write_json_file
from config.config import RETURNS_FILE, RETURN_PRODUCTS_FILE, PRODUCTS_FILE
from routes.return_routes import _resolve_current_store_id
from utils.offline_return_order_queue import enqueue_return_order_create

return_order_bp = Blueprint('return_order', __name__)

ALLOWED_REASON_TYPES = {"damaged", "low_sales", "modification", "other"}


def _attach_lines_to_returns(headers, lines, products):
    """Group return_products lines under their return order and enrich with the
    product snapshot. Produces { ...header, return_products: [ {...line, products} ] }."""
    prod_by_id = {str(p.get("id")): p for p in products if isinstance(p, dict)}
    by_return = {}
    for ln in lines:
        if not isinstance(ln, dict):
            continue
        prod = prod_by_id.get(str(ln.get("product_id") or ""))
        enriched = {
            **ln,
            "products": (
                {
                    "id": prod.get("id"),
                    "name": prod.get("name"),
                    "barcode": prod.get("barcode"),
                    "selling_price": prod.get("selling_price"),
                }
                if prod else None
            ),
        }
        by_return.setdefault(str(ln.get("return_id") or ""), []).append(enriched)

    result = []
    for h in headers:
        if not isinstance(h, dict):
            continue
        result.append({**h, "return_products": by_return.get(str(h.get("return_id") or ""), [])})
    return result


def _dispatch_return_order(supabase, current_user_id, store_id, header, lines):
    """Connectivity-aware create for a store->admin return order. No stock change."""
    if getattr(supabase, "is_offline_fallback", False):
        returns = read_json_file(RETURNS_FILE, [])
        returns.append(header)
        write_json_file(RETURNS_FILE, returns)

        rp = read_json_file(RETURN_PRODUCTS_FILE, [])
        rp.extend(lines)
        write_json_file(RETURN_PRODUCTS_FILE, rp)

        info = enqueue_return_order_create(current_user_id, {"header": header, "lines": lines})
        return {"queued": True, "queue_id": info["queue_id"], "return": header, "items": lines}

    supabase.table("returns").insert(header).execute()
    if lines:
        supabase.table("return_products").insert(lines).execute()
    return {"queued": False, "return": header, "items": lines}


@return_order_bp.route('/return-orders', methods=['POST'])
@require_auth
def create_return_order():
    """Store creates a return order to admin (one order, many product lines)."""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json() or {}
        items = data.get("items", []) or []
        note = (data.get("note") or "").strip()

        if not items:
            return jsonify({"message": "items is required"}), 400

        supabase = get_supabase_client()
        store_id = _resolve_current_store_id(supabase, current_user_id)
        if not store_id:
            return jsonify({"message": "No store assigned to this user"}), 404

        now_iso = datetime.now(timezone.utc).isoformat()
        return_id = f"RET-{uuid.uuid4().hex[:12].upper()}"

        line_rows = []
        total_qty = 0
        for item in items:
            product_id = item.get("productId") or item.get("product_id")
            quantity = int(item.get("quantity") or 0)
            reason_type = (item.get("reasonType") or item.get("reason_type") or "other").strip().lower()
            reason = (item.get("reason") or "").strip()
            if reason_type not in ALLOWED_REASON_TYPES:
                reason_type = "other"
            if not product_id or quantity <= 0:
                continue
            total_qty += quantity
            line_rows.append({
                "id": f"RP-{uuid.uuid4().hex[:12].upper()}",
                "return_id": return_id,
                "product_id": product_id,
                "quantity": quantity,
                "reason": reason or reason_type,
                "reason_type": reason_type,
                "verify_status": "pending",
                "verified_qty": 0,
                "holding_status": "in_transit",
                "notes": item.get("note") or "",
                "created_at": now_iso,
                "updated_at": now_iso,
            })

        if not line_rows:
            return jsonify({"message": "No valid items to submit"}), 400

        header = {
            "return_id": return_id,
            "store_id": store_id,
            "created_by": current_user_id,
            "return_type": "store_to_admin",
            "admin_status": "sent_to_admin",
            "return_quantity": total_qty,
            "message": note,
            "created_at": now_iso,
            "updated_at": now_iso,
        }

        saved = _dispatch_return_order(supabase, current_user_id, store_id, header, line_rows)

        # Notify the admin that a new return order arrived (best-effort).
        try:
            from notifications.notifications import create_notification
            store_name = store_id
            try:
                sresp = supabase.table("stores").select("name").eq("id", store_id).limit(1).execute()
                if sresp.data:
                    store_name = sresp.data[0].get("name") or store_id
            except Exception:
                pass
            create_notification(
                "RETURN_ORDER",
                f"New return order {return_id} from {store_name} ({len(line_rows)} item(s)).",
                related_id=return_id,
                store_id=None,
            )
        except Exception as notify_err:
            app.logger.warning(f"Failed to create return-order notification: {notify_err}")

        return jsonify({
            "message": "Return order submitted",
            "queued": saved.get("queued", False),
            "count": len(line_rows),
            "return": saved["return"],
            "items": saved["items"],
        }), 202 if saved.get("queued") else 201
    except Exception as e:
        app.logger.error(f"❌ Error creating return order: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@return_order_bp.route('/return-orders', methods=['GET'])
@require_auth
def get_return_orders():
    """List this store's return orders (header + nested product lines)."""
    limit = request.args.get("limit", 100, type=int)
    try:
        current_user_id = get_jwt_identity()
        supabase = get_supabase_client()
        store_id = _resolve_current_store_id(supabase, current_user_id)
        if not store_id:
            return jsonify([]), 200

        if getattr(supabase, "is_offline_fallback", False):
            returns = [
                r for r in read_json_file(RETURNS_FILE, [])
                if isinstance(r, dict)
                and str(r.get("store_id")) == str(store_id)
                and r.get("return_type") == "store_to_admin"
            ]
            returns.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
            returns = returns[:limit]
            ids = {str(r.get("return_id")) for r in returns}
            lines = [
                ln for ln in read_json_file(RETURN_PRODUCTS_FILE, [])
                if isinstance(ln, dict) and str(ln.get("return_id")) in ids
            ]
            products = read_json_file(PRODUCTS_FILE, [])
            return jsonify(_attach_lines_to_returns(returns, lines, products)), 200

        resp = (
            supabase.table("returns")
            .select("*")
            .eq("store_id", store_id)
            .eq("return_type", "store_to_admin")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        headers = resp.data or []
        ids = [str(h.get("return_id")) for h in headers if h.get("return_id")]
        lines = []
        if ids:
            lines_resp = (
                supabase.table("return_products")
                .select("*, products(id, name, barcode, selling_price)")
                .in_("return_id", ids)
                .execute()
            )
            lines = lines_resp.data or []
        # products already embedded above; pass [] so we don't double-enrich.
        by_return = {}
        for ln in lines:
            by_return.setdefault(str(ln.get("return_id") or ""), []).append(ln)
        result = [{**h, "return_products": by_return.get(str(h.get("return_id") or ""), [])} for h in headers]
        return jsonify(result), 200
    except Exception as e:
        app.logger.error(f"❌ Error listing return orders: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify([]), 200
