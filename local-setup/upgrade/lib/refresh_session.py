#!/usr/bin/env python3
"""Force ADMIN's session to be re-issued after the deploy.

egov-user keeps serving the pre-upgrade token, which still carries the
pre-upgrade role list, so freshly granted roles look missing until the old
session is logged out. Prints the roles on the new token so the operator can
confirm the grants landed.

Config: KONG_URL, TENANT, ADMIN_USER, ADMIN_PASSWORD.
"""
import os
import sys

# python3 -I drops the script's own directory from sys.path, so the shared
# helper next to this file has to be made importable explicitly. -I is kept
# on purpose: it also ignores any PYTHONPATH or user site-packages the box
# happens to have, which is what we want for a deploy-time script.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from digit_api import env, login, post_json


def main():
    kong = env("KONG_URL", "http://127.0.0.1:18000")
    tenant = env("TENANT", required=True)
    user = env("ADMIN_USER", "ADMIN")
    password = env("ADMIN_PASSWORD", required=True)

    token = login(kong, user, password, tenant)["access_token"]
    post_json(f"{kong}/user/_logout?tenantId={tenant}",
              {"RequestInfo": {"apiId": "Rainmaker", "authToken": token},
               "access_token": token})

    roles = sorted(r["code"] for r in login(kong, user, password, tenant)["UserRequest"]["roles"])
    print(f"  {user} roles now: {', '.join(roles)}")


if __name__ == "__main__":
    main()
