"""The only module that talks to pgr-services."""

import copy
import logging

import requests

from app.domain.errors import PgrRequestFailed
from app.domain.models import FiledComplaint
from app.pgr import payloads

CREATE_PATH = "pgr-services/v2/request/_create"
SEARCH_PATH = "pgr-services/v2/request/_search"
JSON_HEADERS = {"Content-Type": "application/json"}
SEARCH_LIMIT = 200  # pgr.search.max.limit; the service caps anything higher
UNAUTHORIZED = 401  # DIGIT returns this for an expired or invalid authToken
AUTH_RETRIES = 3    # re-login attempts after a 401 before giving up
REDACTED = "[REDACTED]"

logger = logging.getLogger(__name__)



class PgrClient:
    def __init__(self, digit_host, city_tenant_id, search_tenant_id, defaults, session,
                 citizens, extra_filers, timeout_seconds, district_for):
        self._digit_host = digit_host
        self._city_tenant_id = city_tenant_id
        self._search_tenant_id = search_tenant_id
        self._defaults = defaults
        self._session = session
        self._citizens = citizens
        self._extra_filers = extra_filers
        self._timeout_seconds = timeout_seconds
        self._district_for = district_for


    def file(self, complaint) -> FiledComplaint:
        response = self._send(
            CREATE_PATH,
            {"tenantId": self._city_tenant_id},
            lambda officer: payloads.create_body(
                complaint, officer, self._city_tenant_id, self._defaults, self._district_for
            ),
        )
        return _first_complaint(response, "Complaint was created but PGR returned no service")

    def find_by_mobile_number(self, mobile_number):
        """Two searches, merged — see WORKAROUND at the bottom of this module.

        The first is scoped by the officer's department and returns only complaints
        stored under it. The second names the filers explicitly, which makes PGR skip
        department scoping altogether. Both stay restricted to this citizen, because
        `mobileNumber` is what decides ownership.
        """
        found = self._search({"mobileNumber": mobile_number})
        filers = self._known_filers(mobile_number)
        if filers:
            found += self._search({"mobileNumber": mobile_number, "createdBy": ",".join(filers)})
        return _unique(found)

    def _known_filers(self, mobile_number) -> list:
        """Everyone who could have filed for this citizen: themselves, or an officer."""
        officer = self._session.current()
        filers = list(self._citizens.uuids_for(mobile_number, officer))
        for uuid in [officer.user_info.get("uuid")] + list(self._extra_filers):
            if uuid and uuid not in filers:
                filers.append(uuid)
        return filers

    def _search(self, criteria) -> list:
        query = {"tenantId": self._search_tenant_id, "limit": SEARCH_LIMIT}
        query.update(criteria)
        response = self._send(SEARCH_PATH, query, payloads.search_body)
        return [_complaint_from(wrapper) for wrapper in _wrappers(response)]

    def _send(self, path, query, build_body) -> dict:
        """One request, re-authenticated and retried up to AUTH_RETRIES times on 401.

        The token travels INSIDE the body (RequestInfo.authToken), not in a header,
        so each retry has to rebuild it — hence `build_body` rather than a prepared
        dict. DIGIT invalidates tokens well before the `expires_in` it advertises,
        so without this the adapter keeps failing for the rest of the cache TTL.

        Only 401 is retried. A 400 or 500 is the request or the service, and
        repeating it would just double the load.
        """
        response = self._post(path, query, build_body(self._session.current()))

        for attempt in range(1, AUTH_RETRIES + 1):
            if response.status_code != UNAUTHORIZED:
                break
            logger.info(
                "PGR rejected the officer token; re-authenticating (attempt %s of %s)",
                attempt,
                AUTH_RETRIES,
            )
            response = self._post(path, query, build_body(self._session.renew()))

        return _body_of(response, path)

    def _post(self, path, query, body):
        url = self._digit_host + path
        logger.debug(
            "Sending request to PGR",
            extra={"path": url, "query": query, "headers": JSON_HEADERS, "payload": _redacted(body)},
        )
        try:

            response = requests.post(
                url, params=query, json=body, headers=JSON_HEADERS, timeout=self._timeout_seconds
            )
        except requests.RequestException as error:
            raise PgrRequestFailed(f"Could not reach PGR: {error}")

        # returned as-is: `_send` needs the status to decide whether to retry, and
        # `_body_of` is what rejects a non-200
        return response

def _redacted(body: dict) -> dict:
    """The auth token in RequestInfo is a bearer credential - never log it."""
    clone = copy.deepcopy(body)
    request_info = clone.get("RequestInfo")
    if isinstance(request_info, dict) and "authToken" in request_info:
        request_info["authToken"] = REDACTED
    return clone



def _wrappers(response: dict) -> list:
    return response.get("ServiceWrappers") or []


def _first_complaint(response: dict, message_if_empty: str) -> FiledComplaint:
    wrappers = _wrappers(response)
    if not wrappers:
        raise PgrRequestFailed(message_if_empty)
    return _complaint_from(wrappers[0])


def _complaint_from(wrapper: dict) -> FiledComplaint:
    service = wrapper.get("service") or {}
    return FiledComplaint(
        complaint_number=service.get("serviceRequestId"),
        service_code=service.get("serviceCode"),
        status=service.get("applicationStatus"),
        filed_on=(service.get("auditDetails") or {}).get("createdTime"),
        locality_code=((service.get("address") or {}).get("locality") or {}).get("code"),
        landmark=(service.get("address") or {}).get("landmark"),
        citizen_name=((service.get("citizen") or {}).get("name")),
        citizen_mobile_number=((service.get("citizen") or {}).get("mobileNumber")),
        citizen_email=((service.get("citizen") or {}).get("emailId")),
        citizen_address=((service.get("citizen") or {}).get("correspondenceAddress")),
        complaint_description=service.get("description"),
        complaint_type=service.get("additionalFields", {}).get("serviceName"),
        is_confidential=service.get("extendedAttributes", {}).get("isConfidential"),
        institute_name=service.get("extendedAttributes", {}).get("instituteName"),
        documents=_documents_from(wrapper),
    )

def _documents_from(wrapper: dict) -> list:
    verification_documents = (wrapper.get("workflow") or {}).get("verificationDocuments") or []
    return [
        {"documentType": document.get("documentType"), "fileStoreId": document.get("fileStoreId")}
        for document in verification_documents
    ]



def _body_of(response, path) -> dict:
    if response.status_code != 200:
        raise PgrRequestFailed(
            "PGR rejected the request",
            details={"status": response.status_code, "path": path, "body": _short(response.text)},
        )
    return response.json()


def _unique(complaints) -> list:
    """The two searches overlap, so keep the first sighting of each complaint."""
    seen = {}
    for complaint in complaints:
        seen.setdefault(complaint.complaint_number, complaint)
    return list(seen.values())


def _short(text: str, limit: int = 500) -> str:
    return text[:limit]


# WORKAROUND — remove once pgr-services is fixed.
#
# pgr-services scopes an employee's search to their HRMS department, matching against
# the complaint's stored `additionalDetails.department`. That field is resolved once,
# at creation, from the ComplaintHierarchy MDMS master — and in this deployment every
# row of that master has `department: "NA"`. So every complaint filed today is stored
# as "NA", matches no employee's department, and is invisible to the reception officer
# even when they filed it themselves.
#
# PGRService.applyEmployeeDepartmentScope skips the department filter entirely when
# `createdBy` is present:
#
#     if (!CollectionUtils.isEmpty(criteria.getCreatedBy()))
#         return true;
#
# So naming the filers restores the missing complaints. Measured on this deployment for
# one citizen: 13 complaints without `createdBy`, 28 with it.
#
# The department-scoped search is still run and merged, because it also returns
# complaints filed by people we cannot name. The one gap left: a complaint stored as
# "NA" AND filed by someone who is neither the citizen, this officer, nor listed in
# EXTRA_COMPLAINT_FILERS. Add such accounts to that setting.
