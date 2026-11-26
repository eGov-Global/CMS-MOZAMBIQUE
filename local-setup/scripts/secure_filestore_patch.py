#!/usr/bin/env python3
"""Config edits for secure-filestore.sh (VAPT #223: insecure file storage).

    secure_filestore_patch.py kong    <kong.yml>
    secure_filestore_patch.py compose <docker-compose.egov-digit.yaml>
    secure_filestore_patch.py nginx   <site.conf> [--with-zone]
    secure_filestore_patch.py check   <kind> <file>     # report only, never writes

Every edit is anchored on exact text and is idempotent: a file that already
has the change is reported as "already" and left alone. If an anchor is
missing the file is NOT written and the exit code is 3, so the caller can stop
before anything half-applied reaches a running service.

Exit codes: 0 changed (or would change, for check), 10 already done,
3 file doesn't look as expected, 2 usage.
"""
import re
import sys

MARK = "VAPT #223"

# ── Kong ─────────────────────────────────────────────────────────────────────
FS_AUTH_OPTIONAL = (
    '          ["/filestore/v1/file"]=true, ["/filestore/v1/files"]=true, ["/filestore/v1/files/url"]=true,\n'
    '          ["/filestore/v1/files/id"]=true, ["/filestore/v1/files/tag"]=true,\n'
)
FS_AUTH_OPTIONAL_NEW = (
    "          -- /filestore/v1/{file,files,files/url,files/id,files/tag} REMOVED from\n"
    "          -- auth-optional (VAPT #223: insecure file storage). Anyone holding a\n"
    "          -- fileStoreId could download a complaint attachment without logging\n"
    "          -- in. They now need a valid token on every method, incl. multipart\n"
    "          -- uploads, but are not action-RBAC'd. Pictures shown before login\n"
    "          -- (landing page) come from the bucket's public pgr-landing/ prefix.\n"
)

# Variant A: gateways that already enforce non-POST requests (bgrm lineage).
A_RBAC_OLD = '              or p == "/user/_search"\n        end\n'
A_RBAC_NEW = (
    '              or p == "/user/_search"\n'
    "              -- Filestore (VAPT #223): a token is required, but no per-role\n"
    "              -- action check: /files/id has no accesscontrol actions and\n"
    "              -- upload/url are mapped to only some roles, so RBAC would 403\n"
    "              -- admins. A per-file ownership check is a filestore change.\n"
    '              or p == "/filestore/v1/file" or p == "/filestore/v1/files"\n'
    '              or p == "/filestore/v1/files/url" or p == "/filestore/v1/files/id"\n'
    '              or p == "/filestore/v1/files/tag"\n'
    "        end\n"
)
# The gate is matched in two pieces (the `if` line + its is_protected line, and
# the token lines) with anything in between kept as it is. master has a
# CORS-preflight early return there; v2.12.1 and bgrm-lineage gateways don't.
A_GATE_RE = re.compile(
    r'^(?P<i>[ \t]+)if kong\.request\.get_method\(\) ~= "POST" then\n'
    r'(?P<prot>(?P=i)  if not is_protected then return end[^\n]*\n)'
    r'(?P<mid>(?:(?!(?P=i)  local hdr = )[^\n]*\n){0,15}?)'
    r'(?P=i)  local hdr = kong\.request\.get_header\("auth-token"\)\n'
    r'(?P=i)  local q = kong\.request\.get_query\(\)\n'
    r'(?P=i)  local qtok = q and q\["access_token"\]\n'
    r'(?P=i)  local ntoken = \(type\(hdr\) == "string" and hdr ~= "" and hdr\)\n'
    r'(?P<j>[ \t]+)or \(type\(qtok\) == "string" and qtok ~= "" and qtok\) or nil\n',
    re.M,
)


def _upload_check(i):
    """Upload detection: exact media type (the part before any ";"), never a
    substring, and only on the filestore upload paths. Every other POST goes
    through the JSON branch, which replaces RequestInfo.userInfo with the user
    resolved from the token."""
    return (
        f'{i}-- Exact media type (the part before any ";" parameters), never a\n'
        f"{i}-- substring, and only on the filestore upload paths. Every other POST,\n"
        f"{i}-- whatever its Content-Type, goes through the JSON branch below, which\n"
        f"{i}-- replaces RequestInfo.userInfo with the user resolved from the token.\n"
        f'{i}local mtype = type(ctype) == "string" and ctype:lower():match("^%s*([^;%s]+)") or nil\n'
        f"{i}local upath = kong.request.get_path()\n"
        f'{i}local is_upload = mtype == "multipart/form-data"\n'
        f'{i}  and (upath == "/filestore/v1/files" or upath == "/filestore/v1/file")\n'
        f'{i}if kong.request.get_method() ~= "POST" or is_upload then\n'
    )


# The first #223 gate matched "multipart/form-data" as a substring of the
# Content-Type on every path, so `application/json; x="multipart/form-data"`
# skipped the JSON branch and a client-supplied RequestInfo.userInfo reached
# the services. Servers patched with it are re-patched to _upload_check().
GATE_LOOSE_RE = re.compile(
    r'^(?P<i>[ \t]+)local is_multipart = type\(ctype\) == "string" and '
    r'ctype:lower\(\):find\("multipart/form-data", 1, true\) ~= nil\n'
    r'(?P=i)if kong\.request\.get_method\(\) ~= "POST" or is_multipart then\n',
    re.M,
)


def a_gate_new(m):
    i, j = m.group("i"), m.group("j")
    return (
        f"{i}-- Multipart POSTs (filestore uploads, {MARK}) take the same header\n"
        f"{i}-- route: they have no JSON body to carry RequestInfo.authToken.\n"
        f"{i}-- `Authorization: Bearer` is honoured too (digit-ui-v2, configurator, MCP).\n"
        f'{i}local ctype = kong.request.get_header("content-type")\n'
        + _upload_check(i)
        + m.group("prot") + m.group("mid") +
        f'{i}  local hdr = kong.request.get_header("auth-token")\n'
        f'{i}  local authz = kong.request.get_header("authorization")\n'
        f'{i}  local btok = type(authz) == "string" and authz:match("^[Bb]earer%s+(%S+)%s*$") or nil\n'
        f"{i}  local q = kong.request.get_query()\n"
        f'{i}  local qtok = q and q["access_token"]\n'
        f'{i}  local ntoken = (type(hdr) == "string" and hdr ~= "" and hdr)\n'
        f"{j}or btok\n"
        f'{j}or (type(qtok) == "string" and qtok ~= "" and qtok) or nil\n'
    )


# Variant B: older gateways that let every non-POST request through unchecked
# (`if method ~= "POST" then return end`). A dedicated filestore gate is put in
# front of that line; other GETs keep their current behaviour.
B_OLD = '        if kong.request.get_method() ~= "POST" then return end\n'
B_NEW = (
    "        -- Filestore gate (VAPT #223). This gateway lets non-POST requests\n"
    "        -- through unchecked (line below), and uploads are multipart with no\n"
    "        -- JSON body token, so filestore needs its own check: a valid token\n"
    "        -- from the auth-token header, `Authorization: Bearer` or ?access_token,\n"
    "        -- verified against egov-user. No per-role action check.\n"
    "        local function is_filestore(p)\n"
    '          return p == "/filestore/v1/file" or p == "/filestore/v1/files"\n'
    '              or p == "/filestore/v1/files/url" or p == "/filestore/v1/files/id"\n'
    '              or p == "/filestore/v1/files/tag"\n'
    "        end\n"
    "        if is_filestore(uri) then\n"
    '          local fs_ctype = kong.request.get_header("content-type")\n'
    '          local fs_json = kong.request.get_method() == "POST" and type(fs_ctype) == "string"\n'
    '                          and fs_ctype:lower():find("json", 1, true) ~= nil\n'
    "          if not fs_json then\n"
    '            local hdr = kong.request.get_header("auth-token")\n'
    '            local authz = kong.request.get_header("authorization")\n'
    '            local btok = type(authz) == "string" and authz:match("^[Bb]earer%s+(%S+)%s*$") or nil\n'
    "            local q = kong.request.get_query()\n"
    '            local qtok = q and q["access_token"]\n'
    '            local ntoken = (type(hdr) == "string" and hdr ~= "" and hdr) or btok\n'
    '                        or (type(qtok) == "string" and qtok ~= "" and qtok) or nil\n'
    "            local function fs_exit(status, code, desc)\n"
    "              return kong.response.exit(status, cjson.encode({ ResponseInfo = cjson.null,\n"
    "                Errors = {{ code = code, message = code, description = desc }} }),\n"
    '                { ["Content-Type"] = "application/json" })\n'
    "            end\n"
    '            if not ntoken then return fs_exit(401, "InvalidAccessTokenException", "Authentication required for the request") end\n'
    "            local fc = http.new(); fc:set_timeout(5000)\n"
    '            local fr = fc:request_uri("http://egov-user-proxy:8107/user/_details?access_token=" .. ngx.escape_uri(ntoken),\n'
    '              { method = "POST", headers = { ["Content-Type"] = "application/json" } })\n'
    "            if fr and fr.status == 200 then\n"
    "              local okd, u = pcall(cjson.decode, fr.body)\n"
    '              if okd and type(u) == "table" and (u["uuid"] or u["userName"]) then return end\n'
    "            elseif fr and (fr.status == 401 or fr.status == 403\n"
    '                           or (fr.body and fr.body:find("InvalidAccessTokenException", 1, true))) then\n'
    '              return fs_exit(401, "InvalidAccessTokenException", "Invalid access token or access token expired for the request")\n'
    "            end\n"
    '            return fs_exit(503, "AuthServiceUnavailable", "Could not verify authentication for the request; please retry")\n'
    "          end\n"
    "        end\n"
    + B_OLD
)


def _kong_already(s):
    """The fix is in, with or without the marker (e.g. a kong.yml that came
    from the repo after this change): filestore out of AUTH_OPTIONAL and either
    the multipart gate + RBAC exemption, or the dedicated filestore gate."""
    if FS_AUTH_OPTIONAL in s:
        return False
    a = "is_upload" in s and 'p == "/filestore/v1/files/url"' in s
    b = "local function is_filestore(p)" in s
    return a or b


def patch_kong(s):
    loose = list(GATE_LOOSE_RE.finditer(s))
    if len(loose) == 1:
        s = GATE_LOOSE_RE.sub(lambda m: _upload_check(m.group("i")), s, count=1)
        return s, "changed (multipart gate tightened: exact media type, filestore uploads only)"
    if len(loose) > 1:
        return None, "more than one loose multipart gate found; fix by hand"
    if "is_multipart" in s:
        return None, "unrecognised is_multipart gate; check the multipart detection by hand"
    if MARK in s or _kong_already(s):
        return s, "already"
    if FS_AUTH_OPTIONAL not in s:
        return None, "filestore entries not found in AUTH_OPTIONAL"
    s = s.replace(FS_AUTH_OPTIONAL, FS_AUTH_OPTIONAL_NEW, 1)
    gates = list(A_GATE_RE.finditer(s))
    if len(gates) == 1 and s.count(A_RBAC_OLD) == 1:
        s = A_GATE_RE.sub(a_gate_new, s, count=1).replace(A_RBAC_OLD, A_RBAC_NEW, 1)
        return s, "changed (gateway enforces non-POST: filestore made login-only, RBAC-exempt)"
    if s.count(B_OLD) == 1:
        s = s.replace(B_OLD, B_NEW, 1)
        return s, "changed (older gateway: dedicated filestore login gate added)"
    return None, "pre-function shape not recognised (neither known gateway version)"


# ── Compose ──────────────────────────────────────────────────────────────────
MC_OLD = re.compile(r"^(?P<ind>[ \t]+)(?P<mc>mc(?: --config-dir \S+)?) anonymous set download (?P<alias>\w+)/egov-rainmaker;\n", re.M)
POLICY = ('{\\"Version\\":\\"2012-10-17\\",\\"Statement\\":[{\\"Effect\\":\\"Allow\\",\\"Principal\\":{\\"AWS\\":[\\"*\\"]},'
          '\\"Action\\":[\\"s3:GetObject\\"],\\"Resource\\":[\\"arn:aws:s3:::egov-rainmaker/*/pgr-landing/*\\"]}]}')


def patch_compose(s):
    notes = []
    m = MC_OLD.search(s)
    if m:
        ind, mc, alias = m.group("ind"), m.group("mc"), m.group("alias")
        new = (f"{ind}{mc} anonymous set none {alias}/egov-rainmaker;  # {MARK}: private bucket\n"
               f"{ind}echo '{POLICY}' > /tmp/public-landing.json;\n"
               f"{ind}{mc} anonymous set-json /tmp/public-landing.json {alias}/egov-rainmaker;\n")
        s = s[:m.start()] + new + s[m.end():]
        notes.append("minio-init: bucket private, pgr-landing/ public")
    elif "anonymous set none" in s and "egov-rainmaker" in s:
        notes.append("minio-init: already private")
    else:
        return None, "minio-init `anonymous set download` line not found"

    if "PRESIGNED_URL_EXPIRY_TIME_IN_SECS" in s:
        notes.append("filestore link expiry: already set")
    else:
        # Insert after MINIO_URL inside the egov-filestore service block only.
        blk_start = s.find("\n  egov-filestore:\n")
        if blk_start < 0:
            return None, "egov-filestore service not found"
        nxt = re.compile(r"^  [A-Za-z0-9_.-]+:\n", re.M).search(s, blk_start + 2 + len("  egov-filestore:\n"))
        blk_end = nxt.start() if nxt else len(s)
        blk = s[blk_start:blk_end]
        mm = re.search(r"^(?P<ind>[ \t]+)MINIO_URL: .*\n", blk, re.M)
        if not mm:
            return None, "MINIO_URL not found in egov-filestore environment"
        line = f"{mm.group('ind')}PRESIGNED_URL_EXPIRY_TIME_IN_SECS: ${{FILESTORE_URL_EXPIRY_SECS:-3600}}  # {MARK}: 1 h, not 24 h\n"
        blk = blk[:mm.end()] + line + blk[mm.end():]
        s = s[:blk_start] + blk + s[blk_end:]
        notes.append("filestore link expiry: 1 hour")
    changed = any("already" not in n for n in notes)
    return s, ("changed (" if changed else "already (") + "; ".join(notes) + ")"


# ── nginx ────────────────────────────────────────────────────────────────────
ZONE = (
    f"# Upload rate limit ({MARK}): per client IP, POST only; reads are not counted.\n"
    "map $request_method $digit_filestore_upload_key {\n"
    "  POST    $binary_remote_addr;\n"
    '  default "";\n'
    "}\n"
    "limit_req_zone $digit_filestore_upload_key zone=digit_filestore_upload:10m rate=30r/m;\n\n"
)
ROOT_REDIRECT = "return 302 /digit-ui/citizen/pgr/landing;"
ROOT_DENY = (
    f"  # Bucket roots answer an S3 listing; keep it closed ({MARK}).\n"
    "  # Browsers are sent to the citizen landing page, not a bare 403.\n"
    "  location ~ ^/file-store/?([^/]+/?)?$ {\n"
    f"    {ROOT_REDIRECT}\n"
    "  }\n"
)
FS_LOC = re.compile(r"^(?P<ind>[ \t]*)location /file-store/ \{\n", re.M)
FILESTORE_LOC = re.compile(r"^(?P<ind>[ \t]*)location /filestore/ \{\n", re.M)


# The first #223 version answered bucket roots with a bare `return 403;`.
# Servers (or rendered templates) carrying it are re-patched to the redirect.
ROOT_403_RE = re.compile(
    r"^(?P<loc>[ \t]*location ~ \^/file-store/\?\(\[\^/\]\+/\?\)\?\$ \{\n)"
    r"(?P<i>[ \t]*)return 403;\n",
    re.M,
)


def patch_nginx(s, with_zone):
    if ROOT_403_RE.search(s):
        s, n = ROOT_403_RE.subn(lambda m: f"{m.group('loc')}{m.group('i')}{ROOT_REDIRECT}\n", s)
        return s, f"changed (bucket-root 403 replaced by landing-page redirect in {n} server block(s))"
    if MARK in s:
        return s, "already"
    if not FS_LOC.search(s) or not FILESTORE_LOC.search(s):
        return None, "no `location /file-store/` + `location /filestore/` pair"
    s = FS_LOC.sub(lambda m: ROOT_DENY + m.group(0), s)
    s = FILESTORE_LOC.sub(lambda m: m.group(0) + f"{m.group('ind')}    limit_req zone=digit_filestore_upload burst=20 nodelay;\n"
                                     f"{m.group('ind')}    limit_req_status 429;\n", s)
    if with_zone:
        s = ZONE + s
    return s, "changed (bucket-root listing denied; upload rate limit" + (" + zone" if with_zone else "") + ")"


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    check = argv[1] == "check"
    if check:
        argv = argv[1:]
    kind, path = argv[1], argv[2]
    s = open(path, encoding="utf-8").read()
    if kind == "kong":
        new, msg = patch_kong(s)
    elif kind == "compose":
        new, msg = patch_compose(s)
    elif kind == "nginx":
        new, msg = patch_nginx(s, "--with-zone" in argv)
    else:
        print(__doc__)
        return 2
    print(msg)
    if new is None:
        return 3
    if new == s or msg.startswith("already"):
        return 10
    if not check:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
