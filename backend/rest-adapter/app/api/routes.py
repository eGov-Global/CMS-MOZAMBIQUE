"""The contract the citizen portal calls."""

from flask import Blueprint, Response, current_app, jsonify, request


from app.api.auth import requires_api_key
from app.domain.errors import InvalidRequest
from app.domain.models import new_complaint_from


api = Blueprint("api", __name__)


@api.get("/health")
def health():
    return jsonify({"status": "ok-v20260827"})


@api.post("/complaints")
@requires_api_key
def file_complaint():
    complaint = new_complaint_from(request.get_json(silent=True), _phones())
    filed = _pgr().file(complaint)
    return jsonify(_as_json(filed)), 201


@api.get("/complaints")
@requires_api_key
def list_complaints():
    mobile_number = _phones().normalise(request.args.get("mobileNumber", ""))
    if not mobile_number:
        raise InvalidRequest("Query parameter 'mobileNumber' is required")

    complaints = _pgr().find_by_mobile_number(mobile_number)
    return jsonify({"complaints": [_as_json(each) for each in complaints]})

@api.post("/documents")
@requires_api_key
def upload_document():
    uploaded = request.files.get("file")
    if uploaded is None or not uploaded.filename:
        raise InvalidRequest("Form field 'file' is required")

    document_type = request.form.get("documentType", "EVIDENCE").strip() or "EVIDENCE"
    file_store_id = _file_store().upload(uploaded)
    return jsonify({"fileStoreId": file_store_id, "documentType": document_type}), 201


@api.get("/documents/<file_store_id>")
@requires_api_key
def download_document(file_store_id):
    content, content_type = _file_store().download(file_store_id)
    return Response(content, mimetype=content_type)


@api.get("/documents/<file_store_id>/metadata")
@requires_api_key
def document_metadata(file_store_id):
    return jsonify(_file_store().metadata(file_store_id))


@api.get("/master-data/departments")
@requires_api_key
def list_departments():
    departments = _master_data().departments(_locale())
    return jsonify({"departments": [_option_json(each) for each in departments]})


@api.get("/master-data/complaint-types")
@requires_api_key
def walk_complaint_types():
    step = _master_data().complaint_types(_path(), _locale())
    return jsonify(_step_json(step))


@api.get("/master-data/localities")
@requires_api_key
def walk_localities():
    step = _master_data().localities(_path(), _locale())
    return jsonify(_step_json(step))


def _pgr():
    return current_app.config["PGR_CLIENT"]


def _master_data():
    return current_app.config["MASTER_DATA"]


def _phones():
    return current_app.config["PHONES"]

def _file_store():
    return current_app.config["FILE_STORE"]

def _locale():
    return request.args.get("locale", "").strip() or None


def _path() -> list:
    """`?path=GRIEVANCE,WATER` is the codes chosen so far, outermost first."""
    raw = request.args.get("path", "")
    return [code.strip() for code in raw.split(",") if code.strip()]


def _option_json(option) -> dict:
    return {"code": option.code, "name": option.name}


def _step_json(step) -> dict:
    return {
        "level": step.level,
        "path": step.path,
        "isLeaf": step.is_leaf,
        "options": [_option_json(each) for each in step.options],
    }


def _as_json(complaint) -> dict:
    return {
        "complaintNumber": complaint.complaint_number,
        "serviceCode": complaint.service_code,
        "status": complaint.status,
        "filedOn": complaint.filed_on,
        "locality": complaint.locality_code,
        "landmark": complaint.landmark,
        "citizenName": complaint.citizen_name,
        "citizenMobileNumber": complaint.citizen_mobile_number,
        "citizenEmail": complaint.citizen_email,
        "citizenAddress": complaint.citizen_address,
        "description": complaint.complaint_description,
        "complaintType": complaint.complaint_type,
        "isConfidential": complaint.is_confidential,
        "instituteName": complaint.institute_name,
        "documents": complaint.documents,
    }

