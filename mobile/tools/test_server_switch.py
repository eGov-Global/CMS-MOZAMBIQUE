#!/usr/bin/env python3
"""Turn the mobile app's test server switch (Google Play review access) on or off.

After ten taps on a login page's logo the app reads the MDMS record
MobileApp.Settings / TEST_SERVER_SWITCH on the test server. The switch is on
by default; only "enabled": false turns it off (lib/src/server_switch.dart).

    tools/test_server_switch.py status
    MDMS_USER=... MDMS_PASSWORD=... tools/test_server_switch.py off|on

BASE_URL (default https://uat.falacidadao.gov.mz) and TENANT (default mz)
choose the server. MDMS_USER is an employee with MDMS admin rights there.
The first `off` (or `on`) registers the schema and creates the record; both
are safe to run again. Tokens and passwords are never printed.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = os.environ.get("BASE_URL", "https://uat.falacidadao.gov.mz").rstrip("/")
TENANT = os.environ.get("TENANT", "mz")
MODULE, MASTER = "MobileApp", "Settings"
SCHEMA = f"{MODULE}.{MASTER}"
CODE = "TEST_SERVER_SWITCH"
DESCRIPTION = "Ten logo taps in the mobile app open the test server (Google Play review access)."

# Flat on purpose: array or union-typed properties can get x-ref-schema
# stored as {} and break data creation on MDMS v2.
SCHEMA_DEFINITION = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "title": SCHEMA,
    "required": ["code", "enabled"],
    "x-unique": ["code"],
    "x-ref-schema": [],
    "properties": {
        "code": {"type": "string"},
        "enabled": {"type": "boolean"},
        "description": {"type": "string"},
    },
    "additionalProperties": False,
}


def call(path, body, form=False, auth_basic=False):
    """POST to the server; returns (status, parsed JSON or text)."""
    headers = {"Content-Type": "application/x-www-form-urlencoded" if form else "application/json"}
    if auth_basic:
        headers["Authorization"] = "Basic ZWdvdi11c2VyLWNsaWVudDo="  # egov-user-client:
    data = urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode()
    request = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw.decode(errors="replace")[:300]


def errors(payload):
    if isinstance(payload, dict):
        found = [e.get("code") or e.get("message") for e in payload.get("Errors", [])]
        return ", ".join(str(e) for e in found) or payload.get("error_description") or ""
    return str(payload)


def request_info():
    user, password = os.environ.get("MDMS_USER"), os.environ.get("MDMS_PASSWORD")
    if not user or not password:
        sys.exit("Set MDMS_USER and MDMS_PASSWORD (an employee with MDMS admin rights).")
    status, payload = call(
        "/user/oauth/token",
        {"username": user, "password": password, "tenantId": TENANT, "userType": "EMPLOYEE",
         "scope": "read", "grant_type": "password"},
        form=True, auth_basic=True,
    )
    if status != 200 or not isinstance(payload, dict) or "access_token" not in payload:
        sys.exit(f"Sign-in failed (HTTP {status}): {errors(payload)}")
    return {"apiId": "Rainmaker", "authToken": payload["access_token"], "userInfo": payload.get("UserRequest")}


def status():
    code, payload = call("/mdms-v2/v1/_search", {
        "RequestInfo": {"apiId": "Rainmaker"},
        "MdmsCriteria": {"tenantId": TENANT, "moduleDetails": [
            {"moduleName": MODULE, "masterDetails": [{"name": MASTER}]}]},
    })
    if code != 200 or not isinstance(payload, dict):
        sys.exit(f"Search failed (HTTP {code}): {errors(payload)}")
    records = payload.get("MdmsRes", {}).get(MODULE, {}).get(MASTER, [])
    record = next((r for r in records if r.get("code") == CODE), None)
    if record is None:
        print(f"{CODE} on {BASE_URL} ({TENANT}): no record → switch ON (default)")
    else:
        print(f"{CODE} on {BASE_URL} ({TENANT}): {'OFF' if record.get('enabled') is False else 'ON'}")


def find_record(info):
    code, payload = call("/mdms-v2/v2/_search", {
        "RequestInfo": info,
        "MdmsCriteria": {"tenantId": TENANT, "schemaCode": SCHEMA, "uniqueIdentifiers": [CODE]},
    })
    if code != 200 or not isinstance(payload, dict):
        sys.exit(f"Search failed (HTTP {code}): {errors(payload)}")
    return next(iter(payload.get("mdms") or []), None)


def register_schema(info):
    code, payload = call("/mdms-v2/schema/v1/_create", {
        "RequestInfo": info,
        "SchemaDefinition": {"tenantId": TENANT, "code": SCHEMA, "description": DESCRIPTION,
                             "definition": SCHEMA_DEFINITION, "isActive": True},
    })
    if code == 200:
        print(f"Schema {SCHEMA} registered.")
    elif "DUPLICATE" in errors(payload).upper() or "EXIST" in errors(payload).upper():
        pass  # registered by an earlier run
    else:
        sys.exit(f"Schema registration failed (HTTP {code}): {errors(payload)}")


def set_enabled(info, enabled):
    record = find_record(info)
    if record is None:
        register_schema(info)
        code, payload = call(f"/mdms-v2/v2/_create/{SCHEMA}", {
            "RequestInfo": info,
            "Mdms": {"tenantId": TENANT, "schemaCode": SCHEMA, "uniqueIdentifier": CODE, "isActive": True,
                     "data": {"code": CODE, "enabled": enabled, "description": DESCRIPTION}},
        })
        if code != 200:
            sys.exit(f"Record creation failed (HTTP {code}): {errors(payload)}")
        return
    record["data"]["enabled"] = enabled
    record["isActive"] = True
    code, payload = call(f"/mdms-v2/v2/_update/{SCHEMA}", {"RequestInfo": info, "Mdms": record})
    if code != 200:
        sys.exit(f"Update failed (HTTP {code}): {errors(payload)}")


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action == "status":
        status()
    elif action in ("on", "off"):
        set_enabled(request_info(), action == "on")
        status()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
