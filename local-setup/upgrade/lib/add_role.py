#!/usr/bin/env python3
"""Create the bootstrap admin role in MDMS, if it is not already there.

The deploy grants this role to ADMIN and its ADMIN re-provision step fails when
the role does not exist. Writes go straight to mdms-v2 rather than through Kong,
whose v2.12.1 RBAC would itself refuse the call we are making the grant for.

Config comes from the environment (set by upgrade.sh): KONG_URL, MDMS_URL,
TENANT, ADMIN_USER, ADMIN_PASSWORD, ROLE_CODE, ROLE_NAME.
"""
import urllib.error

import os
import sys

# python3 -I drops the script's own directory from sys.path, so the shared
# helper next to this file has to be made importable explicitly. -I is kept
# on purpose: it also ignores any PYTHONPATH or user site-packages the box
# happens to have, which is what we want for a deploy-time script.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from digit_api import env, login, post_json, request_info

SCHEMA = "ACCESSCONTROL-ROLES.roles"


def main():
    kong = env("KONG_URL", "http://127.0.0.1:18000")
    mdms = env("MDMS_URL", "http://127.0.0.1:18094")
    tenant = env("TENANT", required=True)
    code = env("ROLE_CODE", "ACCOUNT_ADMIN")
    name = env("ROLE_NAME", "Account Admin")

    auth = login(kong, env("ADMIN_USER", "ADMIN"),
                 env("ADMIN_PASSWORD", required=True), tenant)

    payload = {
        "RequestInfo": request_info(auth),
        "Mdms": {
            "tenantId": tenant,
            "schemaCode": SCHEMA,
            "isActive": True,
            "data": {
                "code": code,
                "name": name,
                "description": "Bootstrap/tenant-onboarding admin — full Configurator access",
            },
        },
    }

    try:
        status, _ = post_json(f"{mdms}/mdms-v2/v2/_create/{SCHEMA}", payload)
        print(f"  {code}: created ({status})")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        # A duplicate is the normal outcome on a re-run, and on any tenant that
        # was onboarded after the role became part of the seed data.
        if e.code in (400, 409) and ("DUPLICATE" in detail.upper() or "ALREADY" in detail.upper()):
            print(f"  {code}: already present")
        else:
            raise SystemExit(f"  {code}: FAILED {e.code} {detail[:400]}")


if __name__ == "__main__":
    main()
