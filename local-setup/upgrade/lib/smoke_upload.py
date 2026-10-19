#!/usr/bin/env python3
"""Upload smoke test for the virus-scan path (enable_file_scan).

Uploads a harmless text file (must be stored) and the EICAR test string (must be
refused with VIRUS_DETECTED) through the public filestore route, the same path
the UI uses. EICAR is the industry-standard antivirus test string, not malware.

Config: KONG_URL, PUBLIC_URL, PUBLIC_HOST (optional), TENANT, ADMIN_USER, ADMIN_PASSWORD.
Exit code 0 only when both outcomes are as expected.
"""
import os
import sys
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from digit_api import env, login  # noqa: E402

EICAR = rb"X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"


def upload(base, token, tenant, name, content):
    b = uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"tenantId\"\r\n\r\n{tenant}\r\n"
            f"--{b}\r\nContent-Disposition: form-data; name=\"module\"\r\n\r\nPGR\r\n"
            f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
            f"Content-Type: text/plain\r\n\r\n").encode() + content + f"\r\n--{b}--\r\n".encode()
    headers = {"Content-Type": f"multipart/form-data; boundary={b}", "auth-token": token}
    if os.environ.get("PUBLIC_HOST"):
        headers["Host"] = os.environ["PUBLIC_HOST"]
    req = urllib.request.Request(f"{base}/filestore/v1/files", data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def main():
    tenant = env("TENANT", required=True)
    token = login(env("KONG_URL", "http://127.0.0.1:18000"), env("ADMIN_USER", "ADMIN"),
                  env("ADMIN_PASSWORD", required=True), tenant)["access_token"]
    base = env("PUBLIC_URL", "http://localhost")
    ok = True

    code, body = upload(base, token, tenant, "upgrade-smoke.txt", b"upgrade smoke test\n")
    if code in (200, 201) and "fileStoreId" in body:
        print("  ok   clean upload stored")
    else:
        print(f"  FAIL clean upload -> {code} {body[:160]}"); ok = False

    code, body = upload(base, token, tenant, "eicar.txt", EICAR)
    if "VIRUS_DETECTED" in body:
        print("  ok   test-virus upload refused (VIRUS_DETECTED)")
    else:
        print(f"  FAIL test-virus upload -> {code} {body[:160]}"); ok = False
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
