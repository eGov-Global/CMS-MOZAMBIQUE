"""Turns any failure into the one JSON error shape the portal has to handle."""

from flask import jsonify

from app.domain.errors import AdapterError


def register_error_handlers(app):
    app.register_error_handler(AdapterError, _handle_adapter_error)
    app.register_error_handler(404, _handle_not_found)
    app.register_error_handler(Exception, _handle_unexpected)


def _handle_adapter_error(error: AdapterError):
    return _error_response(error.message, error.status_code, error.details)


def _handle_not_found(_error):
    return _error_response("No such endpoint", 404)


def _handle_unexpected(error: Exception):
    return _error_response(f"Unexpected adapter failure: {error}", 500)


def _error_response(message: str, status_code: int, details=None):
    body = {"error": message}
    if details is not None:
        body["details"] = details
    return jsonify(body), status_code
