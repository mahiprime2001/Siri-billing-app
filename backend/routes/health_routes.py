from flask import Blueprint, jsonify
from datetime import datetime

health_bp = Blueprint('health_bp', __name__)

@health_bp.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({
        "status": "online",
        "app": "billing",
        "timestamp": datetime.now().isoformat()
    }), 200
