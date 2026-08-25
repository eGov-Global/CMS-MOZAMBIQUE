"""Builds the two PGR request bodies.

The whole on-behalf-of behaviour lives in `create_body`. PGR decides who owns a
complaint from the type of the *logged-in* user:

  - a CITIZEN caller has `accountId` overwritten with their own uuid;
  - an EMPLOYEE caller keeps whatever the request names.

So the adapter authenticates as an employee, omits `accountId` entirely, and sends
`service.citizen` instead. PGR then looks the citizen up by mobile number and creates
them if they do not exist. Name and mobile number are both mandatory on that block.
"""

APPLY = "APPLY"


def create_body(complaint, officer, city_tenant_id, defaults) -> dict:
    return {
        "RequestInfo": _request_info(officer),
        "service": _service(complaint, city_tenant_id, defaults),
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


def _service(complaint, city_tenant_id, defaults) -> dict:
    return {
        "tenantId": city_tenant_id,
        "serviceCode": complaint.service_code,
        "description": complaint.description,
        "source": defaults.source,
        "citizen": _citizen(complaint, defaults),
        "address": _address(complaint, city_tenant_id),
        "extendedAttributes": _extended_attributes(complaint, defaults),
    }


def _citizen(complaint, defaults) -> dict:
    """No `accountId` anywhere: its absence is what selects the upsert-by-mobile path."""
    return {
        "name": complaint.complainant_name or defaults.citizen_name,
        "mobileNumber": complaint.mobile_number,
        "emailId": complaint.email,
    }



def _address(complaint, city_tenant_id) -> dict:
    """No geoLocation unless the portal sent one: this channel usually has no map."""
    return {
        "city": city_tenant_id,
        "locality": {"code": complaint.locality_code},
        "landmark": complaint.landmark,
        "buildingName": complaint.building_name,
        "street": complaint.street,
        "pincode": complaint.pincode,
        "geoLocation": _geo_location(complaint),
    }


def _geo_location(complaint):
    if complaint.latitude is None or complaint.longitude is None:
        return None
    return {"latitude": complaint.latitude, "longitude": complaint.longitude}



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
