"""Builds the two PGR request bodies.

The whole on-behalf-of behaviour lives in `create_body`. PGR decides who owns a
complaint from the type of the *logged-in* user:

  - a CITIZEN caller has `accountId` overwritten with their own uuid;
  - an EMPLOYEE caller keeps whatever the request names.

So the adapter authenticates as an employee, omits `accountId` entirely, and sends
`service.citizen` instead. PGR then looks the citizen up by mobile number and creates
them if they do not exist. Name and mobile number are both mandatory on that block.
"""

from app.domain.errors import InvalidRequest


APPLY = "APPLY"
# Keyed by locality code (see app/pgr/master_data.py's boundary walk). Only
# Maputo's 7 municipal districts are configured today; anything else falls
# through to InvalidRequest in _geo_location rather than filing with no
# location at all.
LOCALITY_CITY_CENTERS = {
    "kampfumu": {"latitude": -25.969, "longitude": 32.573},
    "nlhamankulu": {"latitude": -25.955, "longitude": 32.588},
    "kamaxakeni": {"latitude": -25.938, "longitude": 32.598},
    "kamavota": {"latitude": -25.930, "longitude": 32.615},
    "kamubukwana": {"latitude": -25.955, "longitude": 32.630},
    "katembe": {"latitude": -25.988, "longitude": 32.556},
    "kanyaka": {"latitude": -26.017, "longitude": 32.933},
}



def create_body(complaint, officer, city_tenant_id, defaults, district_for) -> dict:
    return {
        "RequestInfo": _request_info(officer),
        "service": _service(complaint, city_tenant_id, defaults, district_for),
        "workflow": {"action": APPLY, "verificationDocuments": _verification_documents(complaint)},
    }


def _verification_documents(complaint) -> list:
    return [
        {
            "documentType": document.get("documentType", "EVIDENCE"),
            "fileStoreId": document.get("fileStoreId"),
            "documentUid": "",
            "additionalDetails": {},
        }
        for document in (complaint.documents or [])
    ]


def search_body(officer) -> dict:
    return {"RequestInfo": _request_info(officer)}


def _request_info(officer) -> dict:
    return {"authToken": officer.token, "userInfo": officer.user_info}


def _service(complaint, city_tenant_id, defaults, district_for) -> dict:
    return {
        "tenantId": city_tenant_id,
        "serviceCode": complaint.service_code,
        "description": complaint.description,
        "source": defaults.source,
        "citizen": _citizen(complaint, defaults),
        "address": _address(complaint, city_tenant_id, district_for),
        "extendedAttributes": _extended_attributes(complaint, defaults),
    }


def _citizen(complaint, defaults) -> dict:
    """No `accountId` anywhere: its absence is what selects the upsert-by-mobile path."""
    return {
        "name": complaint.complainant_name or defaults.citizen_name,
        "mobileNumber": complaint.mobile_number,
        "emailId": complaint.email,
    }



def _address(complaint, city_tenant_id, district_for) -> dict:
    """Falls back to the locality's city center when the portal sent no geoLocation."""
    return {
        "city": city_tenant_id,
        "locality": {"code": complaint.locality_code},
        "landmark": complaint.landmark,
        "buildingName": complaint.building_name,
        "street": complaint.street,
        "pincode": complaint.pincode,
        "geoLocation": _geo_location(complaint, district_for),
    }


def _geo_location(complaint, district_for):
    if complaint.latitude is not None and complaint.longitude is not None:
        return {"latitude": complaint.latitude, "longitude": complaint.longitude}

    district = district_for(complaint.locality_code)
    center = LOCALITY_CITY_CENTERS.get(district)
    if center is None:
        raise InvalidRequest(
            f"No geoLocation existant "
            f"for locality '{complaint.locality_code}' (district: {district})"
        )
    return center




def _extended_attributes(complaint, defaults) -> dict:
    return {
        "caseRelatedTo": defaults.case_related_to,
        "instituteName": complaint.institute_name,
        "isConfidential": complaint.is_confidential,
        "complainantName": complaint.complainant_name,
        "complainantAddress": complaint.complainant_address,
        "email": complaint.email,
        "consents": complaint.consents,
        "witnessName": complaint.witness_name,
        "witnessAddress": complaint.witness_address,
        "witnessNote": complaint.witness_note,
    }
