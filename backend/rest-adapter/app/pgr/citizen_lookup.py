"""Resolves a phone number to the citizen's DIGIT uuid(s).

Needed only for the search workaround in `client.py`: complaints are widened by
`createdBy`, and the citizen is one of the creators we have to name.
"""

import requests

from app.domain.errors import PgrRequestFailed

USER_SEARCH_PATH = "user/_search"
CITIZEN_USER_TYPE = "CITIZEN"
JSON_HEADERS = {"Content-Type": "application/json"}


class CitizenLookup:
    def __init__(self, user_service_host, root_tenant_id, timeout_seconds):
        self._url = user_service_host + USER_SEARCH_PATH
        self._root_tenant_id = root_tenant_id
        self._timeout_seconds = timeout_seconds

    def uuids_for(self, mobile_number, officer) -> list:
        """Every uuid the number maps to; a number may have more than one record."""
        body = {
            "RequestInfo": {"apiId": "Rainmaker", "authToken": officer.token},
            "tenantId": self._root_tenant_id,
            "mobileNumber": mobile_number,
            "userType": CITIZEN_USER_TYPE,
        }
        try:
            response = requests.post(
                self._url, json=body, headers=JSON_HEADERS, timeout=self._timeout_seconds
            )
        except requests.RequestException as error:
            raise PgrRequestFailed(f"Could not reach the user service: {error}")

        if response.status_code != 200:
            return []
        return [user["uuid"] for user in _users(response.json()) if user.get("uuid")]


def _users(body: dict) -> list:
    return body.get("user") or body.get("User") or []
