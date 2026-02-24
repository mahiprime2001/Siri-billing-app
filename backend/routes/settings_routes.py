from flask import Blueprint, request, jsonify, current_app as app
from flask_jwt_extended import get_jwt_identity
from auth.auth import require_auth
from utils.connection_pool import get_supabase_client
from helpers.utils import read_json_file
from config.config import SYSTEM_SETTINGS_FILE

settings_bp = Blueprint('settings', __name__)

@settings_bp.route('/settings', methods=['GET'])
@require_auth
def get_settings():
    """Get application settings"""
    try:
        current_user_id = get_jwt_identity()
        app.logger.info(f"User {current_user_id} fetching settings")
        
        supabase = get_supabase_client()
        response = supabase.table('systemsettings').select('*').execute()
        
        if not response.data or len(response.data) == 0:
            app.logger.warning("No settings found in database")
            return jsonify({
                "taxPercentage": 0,
                "gstin": "",
                "companyName": "",
                "companyAddress": "",
                "companyPhone": "",
                "companyEmail": ""
            }), 200
        
        settings = response.data[0]
        
        # ✅ Transform snake_case to camelCase for frontend
        transformed_settings = {
            "id": settings.get('id'),
            "gstin": settings.get('gstin', ''),
            "taxPercentage": float(settings.get('taxpercentage', 0)),  # ✅ Convert to camelCase and float
            "companyName": settings.get('companyname', ''),  # ✅ camelCase
            "companyAddress": settings.get('companyaddress', ''),  # ✅ camelCase
            "companyPhone": settings.get('companyphone', ''),  # ✅ camelCase
            "companyEmail": settings.get('companyemail', ''),  # ✅ camelCase
            "created_at": settings.get('created_at'),
            "updated_at": settings.get('updated_at')
        }
        
        app.logger.info(f"✅ Settings fetched with tax: {transformed_settings['taxPercentage']}%")
        app.logger.info(f"📊 Transformed settings: {transformed_settings}")
        
        return jsonify(transformed_settings), 200
        
    except Exception as e:
        app.logger.error(f"Error fetching settings: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        cached = read_json_file(SYSTEM_SETTINGS_FILE, {})
        if not isinstance(cached, dict):
            cached = {}
        transformed_settings = {
            "id": cached.get('id'),
            "gstin": cached.get('gstin', ''),
            "taxPercentage": float(cached.get('taxpercentage', 0) or 0),
            "companyName": cached.get('companyname', ''),
            "companyAddress": cached.get('companyaddress', ''),
            "companyPhone": cached.get('companyphone', ''),
            "companyEmail": cached.get('companyemail', ''),
            "created_at": cached.get('created_at'),
            "updated_at": cached.get('updated_at')
        }
        return jsonify(transformed_settings), 200


@settings_bp.route('/settings', methods=['PUT'])
@require_auth
def update_settings():
    """Update application settings"""
    try:
        current_user_id = get_jwt_identity()
        data = request.get_json()
        app.logger.info(f"User {current_user_id} updating settings with data: {data}")
        
        # ✅ Transform camelCase from frontend to snake_case for database
        db_data = {}
        base_version = data.get("baseVersion") or data.get("base_version")
        base_updated_at = data.get("baseUpdatedAt") or data.get("base_updated_at")
        
        if 'taxPercentage' in data:
            db_data['taxpercentage'] = float(data['taxPercentage'])
        if 'gstin' in data:
            db_data['gstin'] = data['gstin']
        if 'companyName' in data:
            db_data['companyname'] = data['companyName']
        if 'companyAddress' in data:
            db_data['companyaddress'] = data['companyAddress']
        if 'companyPhone' in data:
            db_data['companyphone'] = data['companyPhone']
        if 'companyEmail' in data:
            db_data['companyemail'] = data['companyEmail']
        
        app.logger.info(f"📤 Transformed data for DB: {db_data}")
        
        supabase = get_supabase_client()
        
        # Get the first settings record ID
        existing = supabase.table('systemsettings').select('id').execute()
        
        if existing.data and len(existing.data) > 0:
            # Update existing
            settings_id = existing.data[0]['id']
            query = supabase.table('systemsettings').update(db_data).eq('id', settings_id)
            if base_version is not None:
                try:
                    base_version = int(base_version)
                    db_data['version'] = base_version + 1
                    query = query.eq('version', base_version)
                except (TypeError, ValueError):
                    return jsonify({"message": "Invalid baseVersion"}), 400
            elif base_updated_at:
                query = query.eq('updated_at', base_updated_at)
            else:
                latest = supabase.table('systemsettings').select('id, updated_at, version').eq('id', settings_id).limit(1).execute()
                return jsonify({
                    "message": "Conflict check required. Send baseVersion or baseUpdatedAt.",
                    "latest": latest.data[0] if latest.data else None,
                }), 409

            response = query.execute()
            if not response.data:
                latest = supabase.table('systemsettings').select('*').eq('id', settings_id).limit(1).execute()
                return jsonify({
                    "message": "Update conflict: settings changed in another app/session.",
                    "latest": latest.data[0] if latest.data else None,
                }), 409
        else:
            # Insert new
            response = supabase.table('systemsettings').insert(db_data).execute()
        
        updated_settings = response.data[0] if response.data and len(response.data) > 0 else {}
        
        # Transform back to camelCase for response
        transformed = {
            "id": updated_settings.get('id'),
            "gstin": updated_settings.get('gstin', ''),
            "taxPercentage": float(updated_settings.get('taxpercentage', 0)),
            "companyName": updated_settings.get('companyname', ''),
            "companyAddress": updated_settings.get('companyaddress', ''),
            "companyPhone": updated_settings.get('companyphone', ''),
            "companyEmail": updated_settings.get('companyemail', ''),
        }
        
        app.logger.info(f"✅ Settings updated by user {current_user_id}")
        
        return jsonify(transformed), 200
        
    except Exception as e:
        app.logger.error(f"Error updating settings: {str(e)}")
        import traceback
        app.logger.error(traceback.format_exc())
        return jsonify({"message": "An error occurred"}), 500
