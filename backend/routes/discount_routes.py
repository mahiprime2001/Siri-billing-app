from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client
from datetime import datetime, timezone
import uuid
import traceback

discount_bp = Blueprint('discount', __name__)


@discount_bp.route('/discounts/request', methods=['POST'])
@require_auth
def request_discount():
    """Create a discount approval request (for discounts > 10%)."""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json() or {}

        discount_percentage = data.get('discount_percentage')
        discount_amount = data.get('discount_amount', 0)
        bill_id = data.get('bill_id')

        if discount_percentage is None:
            return jsonify({"message": "discount_percentage is required"}), 400

        if discount_percentage <= 10:
            return jsonify({"message": "Discount approval not required for 10% or less"}), 400

        discount_id = f"DISC-{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).isoformat()

        discount_data = {
            "discount_id": discount_id,
            "user_id": current_user_id,
            "discount": discount_percentage,
            "discount_amount": discount_amount,
            "bill_id": bill_id,
            "status": "pending",
            "created_at": now,
            "updated_at": now,
        }

        supabase = get_supabase_client()
        response = supabase.table('discounts').insert(discount_data).execute()

        if not response.data:
            return jsonify({"message": "Failed to create discount request"}), 500

        return jsonify({
            "discount_id": discount_id,
            "status": "pending",
        }), 201

    except Exception as e:
        app.logger.error(f"❌ Error creating discount request: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@discount_bp.route('/discounts/<discount_id>', methods=['GET'])
@require_auth
def get_discount(discount_id):
    """Get a discount request by ID."""
    try:
        supabase = get_supabase_client()
        response = supabase.table('discounts').select('*').eq('discount_id', discount_id).limit(1).execute()

        if not response.data:
            return jsonify({"message": "Discount request not found"}), 404

        return jsonify(response.data[0]), 200

    except Exception as e:
        app.logger.error(f"❌ Error fetching discount request: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500


@discount_bp.route('/discounts/<discount_id>', methods=['PATCH'])
@require_auth
def update_discount_status(discount_id):
    """Update discount request status (approved/denied)."""
    try:
        data = request.get_json() or {}
        status = data.get('status')

        if status not in ["approved", "denied", "pending"]:
            return jsonify({"message": "Invalid status"}), 400

        supabase = get_supabase_client()

        update_data = {
            "status": status,
            "updated_at": datetime.now(timezone.utc).isoformat()
        }

        response = supabase.table('discounts').update(update_data).eq('discount_id', discount_id).execute()

        if not response.data:
            return jsonify({"message": "Discount request not found"}), 404

        return jsonify(response.data[0]), 200

    except Exception as e:
        app.logger.error(f"❌ Error updating discount request: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500
