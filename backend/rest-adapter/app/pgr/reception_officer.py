"""Logs in as the reception officer and keeps that session usable.

DIGIT issues a token with no usable expiry field and offers no refresh endpoint, so
the adapter re-authenticates on a fixed interval rather than reacting to an expiry.
"""

import threading
import time
from dataclasses import dataclass

import requests

from app.domain.errors import ReceptionOfficerLoginFailed

OAUTH_PATH = "user/oauth/token"
EMPLOYEE_USER_TYPE = "EMPLOYEE"


@dataclass(frozen=True)
class AuthenticatedOfficer:
    """The two things every PGR call needs: who is calling, and their token."""

    token: str
    user_info: dict


class ReceptionOfficerSession:
    def __init__(self, credentials, user_service_host, token_ttl_seconds, timeout_seconds):
        self._credentials = credentials
        self._url = user_service_host + OAUTH_PATH
        self._token_ttl_seconds = token_ttl_seconds
        self._timeout_seconds = timeout_seconds
        self._lock = threading.Lock()
        self._officer = None
        self._obtained_at = 0.0

    def current(self) -> AuthenticatedOfficer:
        with self._lock:
            if self._is_stale():
                self._officer = self._log_in()
                self._obtained_at = time.monotonic()
            return self._officer

    def _is_stale(self) -> bool:
        if self._officer is None:
            return True
        return time.monotonic() - self._obtained_at >= self._token_ttl_seconds

    def _log_in(self) -> AuthenticatedOfficer:
        if not self._credentials.is_complete:
            raise ReceptionOfficerLoginFailed("Reception officer credentials are not configured")

        response = self._post_credentials()
        if response.status_code != 200:
            raise ReceptionOfficerLoginFailed(
                "Reception officer login was rejected",
                details={"status": response.status_code, "body": _short(response.text)},
            )
        return _officer_from(response.json())

    def _post_credentials(self):
        try:
            return requests.post(
                self._url,
                data=self._login_form(),
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Authorization": self._credentials.basic_auth_header,
                },
                timeout=self._timeout_seconds,
            )
        except requests.RequestException as error:
            raise ReceptionOfficerLoginFailed(f"Could not reach the user service: {error}")

    def _login_form(self) -> dict:
        return {
            "grant_type": "password",
            "scope": "read",
            "userType": EMPLOYEE_USER_TYPE,
            "username": self._credentials.username,
            "password": self._credentials.password,
            "tenantId": self._credentials.tenant_id,
        }


def _officer_from(body: dict) -> AuthenticatedOfficer:
    token = body.get("access_token")
    user_info = body.get("UserRequest")
    if not token or not user_info:
        raise ReceptionOfficerLoginFailed("Login response had no access_token or UserRequest")
    return AuthenticatedOfficer(token=token, user_info=user_info)


def _short(text: str, limit: int = 300) -> str:
    return text[:limit]
