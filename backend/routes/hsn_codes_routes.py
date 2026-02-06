from flask import Blueprint, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client
from data_access.data_access import get_hsn_codes_data, save_hsn_codes_data
import traceback

hsn_codes_bp = Blueprint('hsn_codes', __name__)


@hsn_codes_bp.route('/hsn-codes', methods=['GET'])
@require_auth
def get_hsn_codes():
    """Get HSN codes from Supabase and cache to JSON."""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching HSN codes")

        supabase = get_supabase_client()
        if supabase:
            response = supabase.table('hsn_codes') \
                .select('id, hsn_code, created_at, updated_at') \
                .order('hsn_code') \
                .execute()

            hsn_codes = response.data if response.data else []
            if hsn_codes:
                save_hsn_codes_data(hsn_codes)

            return jsonify(hsn_codes), 200

        hsn_codes = get_hsn_codes_data()
        return jsonify(hsn_codes), 200

    except Exception as e:
        app.logger.error(f"Error fetching HSN codes: {str(e)}")
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred", "error": str(e)}), 500
