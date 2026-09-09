"""What a complaint is, independent of how PGR happens to spell it."""

from dataclasses import dataclass
from typing import Optional

from app.domain.errors import InvalidRequest
from dataclasses import dataclass, field



@dataclass(frozen=True)
class NewComplaint:
    mobile_number: str
    service_code: str
    description: str
    locality_code: str
    institute_name: str
    consents: list
    documents: list = None
    is_confidential: bool = False
    landmark: Optional[str] = None
    building_name: Optional[str] = None
    street: Optional[str] = None
    pincode: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    complainant_name: Optional[str] = None
    complainant_address: Optional[str] = None
    email: Optional[str] = None
    witness_name: Optional[str] = None
    witness_address: Optional[str] = None
    witness_note: Optional[str] = None



@dataclass(frozen=True)
class Option:
    """One choice the portal can show: a stable code and a human label."""

    code: str
    name: str


@dataclass(frozen=True)
class WalkStep:
    """One level of a tree the portal walks, one request at a time."""

    level: str
    options: list
    is_leaf: bool
    path: list


@dataclass(frozen=True)
class FiledComplaint:
    complaint_number: str
    service_code: str
    status: str
    filed_on: Optional[int]
    locality_code: Optional[str]
    citizen_mobile_number: str
    complaint_description: str
    complaint_type: str
    is_confidential: bool
    institute_name: str
    landmark: Optional[str] = None
    citizen_name: Optional[str] = None
    citizen_email: Optional[str] = None
    citizen_address: Optional[str] = None
    documents: list = field(default_factory=list)


REQUIRED_FIELDS = ("mobileNumber", "serviceCode", "description", "locality", "instituteName")
CONSENT_VALUES = ('TRUTHFULNESS', 'DATA_PROCESSING')


def new_complaint_from(payload, phones) -> NewComplaint:
    """Translate the portal's JSON into a complaint, or say exactly what is missing."""
    if not isinstance(payload, dict):
        raise InvalidRequest("Request body must be a JSON object")

    missing = [field for field in REQUIRED_FIELDS if not _text(payload.get(field))]
    consents = payload.get("consents")
    documents=payload.get("documents") or []

    if not isinstance(consents, list) or not consents:
        missing.append("consents")
    else:
        invalid_consents = [c for c in consents if c not in CONSENT_VALUES]
        if invalid_consents:
            raise InvalidRequest("Invalid consent value(s)", details=invalid_consents)
        
    if missing:
        raise InvalidRequest("Missing required field(s)", details=missing)

    geo_location = payload.get("geoLocation") or {}

    return NewComplaint(
        mobile_number=phones.normalise(payload["mobileNumber"]),
        service_code=_text(payload["serviceCode"]),
        description=_text(payload["description"]),
        locality_code=_text(payload["locality"]),
        institute_name=_text(payload["instituteName"]),
        consents=consents,
        documents=documents,
        is_confidential=payload.get("isConfidential") is True,
        landmark=_text(payload.get("landmark")) or None,
        building_name=_text(payload.get("buildingName")) or None,
        street=_text(payload.get("street")) or None,
        pincode=_text(payload.get("pincode")) or None,
        latitude=geo_location.get("latitude"),
        longitude=geo_location.get("longitude"),
        complainant_name=_text(payload.get("complainantName")) or None,
        complainant_address=_text(payload.get("complainantAddress")) or None,
        email=_text(payload.get("email")) or None,
        witness_name=_text(payload.get("witnessName")) or None,
        witness_address=_text(payload.get("witnessAddress")) or None,
        witness_note=_text(payload.get("witnessNote")) or None,
    )



def _text(value) -> str:
    return str(value).strip() if value is not None else ""
