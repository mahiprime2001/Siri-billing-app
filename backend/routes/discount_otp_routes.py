from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity

from auth.auth import require_auth
from utils.connection_pool import get_supabase_client
from utils.twofa import verify_twofa
from datetime import datetime, timezone
import uuid
import traceback

discount_otp_bp = Blueprint('discount_otp', __name__)


@discount_otp_bp.route('/discounts/verify-otp', methods=['POST'])
@require_auth
def verify_discount_otp():
    """
    Verify OTP for discount >10%. Approves the discount on success.
    Expected payload:
      {
        "otp": "123456",
        "discount_id": "...",        # preferred
        "discount_request_id": "...",# alias
        "bill_id": "...",            # optional until bill is created
        "discount_percentage": 12,
        "discount_amount": 150
      }
    """
    try:
        payload = request.get_json() or {}
        discount_id = payload.get('discount_id') or payload.get('discount_request_id')
        bill_id = payload.get('bill_id')
        otp = payload.get('otp')
        discount_percentage = payload.get('discount_percentage')
        discount_amount = payload.get('discount_amount')
        user_id = get_jwt_identity()

        if not otp:
            return jsonify({"message": "otp is required"}), 400

        if not discount_id and not bill_id:
            return jsonify({"message": "discount_id or bill_id is required"}), 400

        # First, try to verify OTP against the caller's own secret
        valid, message = verify_twofa(user_id, otp)
        approver_user_id = user_id if valid else None

        if not valid:
            # Fallback: check the OTP against all configured secrets to allow delegated approval
            supabase = get_supabase_client()
            secrets_resp = supabase.table("two_factor").select("user_id, secret").execute()
            matched_id = None

            if secrets_resp.data:
                for row in secrets_resp.data:
                    try:
                        secret = row.get("secret")
                        candidate_user_id = row.get("user_id")
                        if not secret or not candidate_user_id:
                            continue
                        totp = verify_twofa(candidate_user_id, otp)
                    except Exception:
                        continue

                    # verify_twofa returns (bool, msg)
                    if isinstance(totp, tuple):
                        is_valid, _ = totp
                    else:
                        is_valid = False

                    if is_valid:
                        matched_id = candidate_user_id
                        break

            if not matched_id:
                return jsonify({"message": "Invalid or expired code for all configured approvers"}), 400

            approver_user_id = matched_id

        supabase = get_supabase_client()
        now = datetime.now(timezone.utc).isoformat()

        # Locate the discount record: prefer discount_id, fallback to bill_id
        discount_query = supabase.table('discounts').select('discount_id, bill_id').limit(1)
        if discount_id:
            discount_query = discount_query.eq('discount_id', discount_id)
        elif bill_id:
            discount_query = discount_query.eq('bill_id', bill_id)

        existing = discount_query.execute()
        if not existing.data:
            return jsonify({"message": "Discount request not found"}), 404

        target_discount_id = existing.data[0].get('discount_id')

        update_payload = {
            'status': 'approved',
            'updated_at': now,
        }
        # Only attach bill_id if provided *and* exists in bills to avoid FK errors
        if bill_id:
            try:
                bill_exists_resp = supabase.table('bills').select('id').eq('id', bill_id).limit(1).execute()
                if bill_exists_resp.data:
                    update_payload['bill_id'] = bill_id
            except Exception:
                app.logger.warning(f"Skipping bill_id linkage for discount {target_discount_id}; bill lookup failed")
        if discount_percentage is not None:
            update_payload['discount'] = discount_percentage
        if discount_amount is not None:
            update_payload['discount_amount'] = discount_amount
        if approver_user_id:
            update_payload['approved_by'] = approver_user_id

        response = supabase.table('discounts') \
            .update(update_payload) \
            .eq('discount_id', target_discount_id) \
            .execute()

        return jsonify({
            "message": "OTP verified, discount approved",
            "status": "approved",
            "approved_by": approver_user_id,
            "bill_linked": 'bill_id' in update_payload
        }), 200

    except Exception as e:
        app.logger.error(f"Error verifying discount OTP: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500
