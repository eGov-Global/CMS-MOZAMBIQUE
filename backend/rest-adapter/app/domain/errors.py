"""Failures the adapter can explain to its caller."""


class AdapterError(Exception):
    """Base class. `status_code` is what the portal will receive."""

    status_code = 500

    def __init__(self, message: str, details=None):
        super().__init__(message)
        self.message = message
        self.details = details


class InvalidRequest(AdapterError):
    status_code = 400


class Unauthorized(AdapterError):
    status_code = 401


class ReceptionOfficerLoginFailed(AdapterError):
    status_code = 502


class PgrRequestFailed(AdapterError):
    status_code = 502


class PgrRequestFailed(AdapterError):
    status_code = 502


class FileUploadFailed(AdapterError):
    status_code = 502
