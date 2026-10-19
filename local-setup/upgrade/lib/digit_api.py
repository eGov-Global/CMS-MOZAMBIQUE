"""Minimal DIGIT auth helpers shared by the upgrade steps.

Deliberately stdlib-only: these run on a freshly-provisioned server where pip
installs are not guaranteed, and they are invoked with `python3 -I` so a stray
PYTHONPATH on the box cannot shadow them.
"""
import json
import os
import urllib.parse
import urllib.request

# The public DIGIT client id with an empty secret, base64 of "egov-user-client:".
# Every DIGIT deployment ships this; it is not a credential.
BASIC_AUTH = "Basic ZWdvdi11c2VyLWNsaWVudDo="


def env(name, default=None, required=False):
    v = os.environ.get(name, default)
    if required and not v:
        raise SystemExit(f"{name} is not set")
    return v


def login(kong_url, user, password, tenant, user_type="EMPLOYEE"):
    """Return the decoded /user/oauth/token response."""
    body = urllib.parse.urlencode({
        "grant_type": "password",
        "username": user,
        "password": password,
        "scope": "read",
        "tenantId": tenant,
        "userType": user_type,
    }).encode()
    req = urllib.request.Request(
        f"{kong_url}/user/oauth/token",
        data=body,
        headers={"Authorization": BASIC_AUTH,
                 "Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def request_info(auth):
    return {"apiId": "Rainmaker",
            "authToken": auth["access_token"],
            "userInfo": auth["UserRequest"]}


def post_json(url, payload, timeout=30):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()
