#!/usr/bin/env python3
"""
Setup-specific security rules for the CMS/DIGIT Ansible remote-server deployment.

Generic scanners (Checkov ansible, KICS docker-compose) miss the highest-value risks
for THIS stack, or mis-prioritise them. These deterministic rules were derived from a
security review of local-setup/ansible + the docker-compose files AND a read-only audit
of the live cms-pilot VM (no host firewall; datastores bound to 0.0.0.0; etc.).

Output: JSON list of raw findings in the shape security_report.py consumes
(source/area/severity/id/title/file/line), which are then grouped, given curated
why/fix/category/reference, AI-triaged, and published like every other finding.

Env: BASE (repo root, default "."), OUT (default custom.json)
"""
import os, re, json, glob

BASE = os.environ.get("BASE", ".")
OUT = os.environ.get("OUT", "custom.json")
ANSIBLE = os.path.join(BASE, "local-setup", "ansible")

findings = []


def add(rid, title, sev, area, path, line):
    rel = os.path.relpath(path, BASE).replace(os.sep, "/")
    findings.append({"source": "Custom", "area": area, "severity": sev,
                     "id": rid, "title": title, "file": rel, "line": line, "desc": "", "guide": ""})


def walk(root, exts):
    for dp, _, fns in os.walk(root):
        if "/.git" in dp:
            continue
        for fn in fns:
            if fn.endswith(exts):
                yield os.path.join(dp, fn)


def readlines(p):
    try:
        return open(p, encoding="utf-8", errors="ignore").read().splitlines()
    except Exception:
        return []


def compose_files():
    seen, out = set(), []
    for pat in ("docker-compose*.y*ml", "local-setup/docker-compose*.y*ml", "local-setup/**/docker-compose*.y*ml"):
        for f in glob.glob(os.path.join(BASE, pat), recursive=True):
            if f not in seen and os.path.isfile(f):
                seen.add(f); out.append(f)
    return out


# ---------------------------------------------------------------------------
# CMS-SEC-01  Weak / default credentials
# ---------------------------------------------------------------------------
WEAK = re.compile(r"(eGov@123|Digit@12345|\bminioadmin\b|\begov123\b|:\s*['\"]?changeme['\"]?|password['\"]?\s*[:=]\s*['\"]?(admin|password|postgres|root)['\"]?)", re.I)
CRED_CTX = re.compile(r"pass(word|wd)?|secret|token|admin|cred", re.I)
for p in walk(ANSIBLE, (".yml", ".yaml", ".j2", ".env", ".ini")):
    for i, ln in enumerate(readlines(p), 1):
        s = ln.strip()
        if s.startswith("#"):
            continue
        if WEAK.search(ln) and CRED_CTX.search(ln):
            add("CMS-SEC-01", "Weak or default credential in deployment config", "HIGH", "ansible", p, i)


# ---------------------------------------------------------------------------
# CMS-SEC-02  Remote script piped straight into a shell (curl|bash)
# ---------------------------------------------------------------------------
PIPE = re.compile(r"(curl|wget)\b[^|#\n]*\|\s*(sudo\s+)?(bash|sh)\b")
for p in list(walk(ANSIBLE, (".yml", ".yaml", ".j2", ".sh"))):
    for i, ln in enumerate(readlines(p), 1):
        if ln.lstrip().startswith("#"):
            continue
        if PIPE.search(ln):
            add("CMS-SEC-02", "Remote script piped directly into a shell", "HIGH", "ansible", p, i)


# ---------------------------------------------------------------------------
# CMS-SEC-03  Insecure Docker registry (plaintext HTTP / insecure-registries)
# ---------------------------------------------------------------------------
INSEC = re.compile(r"insecure[_-]regist(ry|ries)\b")
for p in walk(ANSIBLE, (".yml", ".yaml", ".j2")):
    for i, ln in enumerate(readlines(p), 1):
        s = ln.strip()
        if s.startswith("#") or not INSEC.search(ln):
            continue
        # only flag when it actually carries a value (not an empty list / key alone)
        val = ln.split(":", 1)[-1].strip()
        if val and val not in ("[]", "{}", "''", '""'):
            add("CMS-SEC-03", "Docker image registry used over insecure HTTP", "HIGH", "ansible", p, i)


# ---------------------------------------------------------------------------
# CMS-SEC-04  SSH host-key verification disabled
# ---------------------------------------------------------------------------
NOHOSTKEY = re.compile(r"StrictHostKeyChecking\s*=?\s*no|host_key_checking\s*=\s*False", re.I)
for p in list(walk(ANSIBLE, (".yml", ".yaml", ".j2", ".sh", ".cfg", ".ini"))):
    for i, ln in enumerate(readlines(p), 1):
        if ln.lstrip().startswith("#"):
            continue
        if NOHOSTKEY.search(ln):
            add("CMS-SEC-04", "SSH host-key verification disabled", "HIGH", "ansible", p, i)


# ---------------------------------------------------------------------------
# CMS-SEC-05  nginx template missing security response headers
# ---------------------------------------------------------------------------
for p in glob.glob(os.path.join(ANSIBLE, "templates", "*nginx*.j2")):
    txt = "\n".join(readlines(p))
    checks = [("server_tokens off", re.compile(r"server_tokens\s+off", re.I)),
              ("Strict-Transport-Security (HSTS)", re.compile(r"Strict-Transport-Security", re.I)),
              ("X-Content-Type-Options: nosniff", re.compile(r"X-Content-Type-Options", re.I))]
    for label, rx in checks:
        if not rx.search(txt):
            add("CMS-SEC-05", f"nginx is missing the security header: {label}", "MEDIUM", "ansible", p, 1)


# ---------------------------------------------------------------------------
# CMS-SEC-06  systemd unit template without sandboxing
# ---------------------------------------------------------------------------
for p in glob.glob(os.path.join(ANSIBLE, "templates", "*.service*")) + glob.glob(os.path.join(ANSIBLE, "**", "*.service.j2"), recursive=True):
    lines = readlines(p)
    txt = "\n".join(lines)
    if "[Service]" not in txt:
        continue
    svc_line = next((i for i, l in enumerate(lines, 1) if "[Service]" in l), 1)
    for label, rx in [("NoNewPrivileges=true", re.compile(r"NoNewPrivileges\s*=\s*(true|yes)", re.I)),
                      ("a non-root User=", re.compile(r"^\s*User\s*=", re.I | re.M)),
                      ("ProtectSystem=", re.compile(r"ProtectSystem\s*=", re.I))]:
        if not rx.search(txt):
            add("CMS-SEC-06", f"systemd service runs without hardening ({label})", "MEDIUM", "ansible", p, svc_line)


# ---------------------------------------------------------------------------
# CMS-SEC-07  Datastore / admin port published on all interfaces (0.0.0.0)
#   Live cms-pilot has no host firewall, so these rely solely on the cloud
#   security group - a single control. Bind to 127.0.0.1 (or a private iface).
# ---------------------------------------------------------------------------
DATA_PORTS = {5432: "PostgreSQL", 6379: "Redis", 9092: "Kafka", 9093: "Kafka", 29092: "Kafka",
              2181: "ZooKeeper", 9200: "Elasticsearch", 9300: "Elasticsearch", 27017: "MongoDB",
              3306: "MySQL/MariaDB", 9000: "MinIO/S3", 9001: "MinIO console", 8086: "InfluxDB",
              5601: "Kibana", 8888: "Jupyter", 11211: "Memcached", 9090: "Prometheus", 9042: "Cassandra",
              8200: "Vault/OpenBao"}
PORTMAP = re.compile(r"""^\s*-\s*["']?(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d+):(\d+)(?:/(?:tcp|udp))?["']?\s*$""")
for p in compose_files():
    for i, ln in enumerate(readlines(p), 1):
        if ln.lstrip().startswith("#"):
            continue
        m = PORTMAP.match(ln)
        if not m:
            continue
        host_ip, cport = m.group(1), int(m.group(3))
        if cport in DATA_PORTS and (host_ip is None or host_ip == "0.0.0.0"):
            add("CMS-SEC-07", f"{DATA_PORTS[cport]} port published on all interfaces (0.0.0.0)", "HIGH", "docker-compose", p, i)


# ---------------------------------------------------------------------------
# CMS-SEC-08  Unauthenticated admin / API surface exposed via nginx
# ---------------------------------------------------------------------------
for p in glob.glob(os.path.join(ANSIBLE, "templates", "*nginx*.j2")):
    lines = readlines(p)
    for i, ln in enumerate(lines, 1):
        lm = re.match(r"\s*location\s*(=\s*)?(/mcp\b|/v1/\b)", ln)
        if not lm:
            continue
        # look ahead in the block for an auth directive
        block = "\n".join(lines[i - 1:i + 25])
        if not re.search(r"auth_basic|auth_request|auth_jwt|satisfy", block, re.I):
            add("CMS-SEC-08", "Unauthenticated admin/API surface exposed via nginx", "HIGH", "ansible", p, i)


# ---------------------------------------------------------------------------
# CMS-SEC-09  No host firewall configured by the playbook
#   (live cms-pilot: ufw inactive; ~33 ports on 0.0.0.0 rely on the cloud SG alone)
# ---------------------------------------------------------------------------
FW = re.compile(r"\b(ufw|firewalld|community\.general\.ufw|ansible\.posix\.firewalld|iptables|nftables)\b")
has_fw = False
playbook = os.path.join(ANSIBLE, "playbook-deploy.yml")
for p in walk(ANSIBLE, (".yml", ".yaml")):
    for ln in readlines(p):
        if ln.lstrip().startswith("#"):
            continue
        if FW.search(ln):
            has_fw = True
            break
    if has_fw:
        break
if not has_fw and os.path.isfile(playbook):
    add("CMS-SEC-09", "Deployment configures no host firewall", "MEDIUM", "ansible", playbook, 1)


# ---------------------------------------------------------------------------
# CMS-SEC-10  Security lint rules disabled in .ansible-lint
#   The repo's own ansible-lint config skips security rules, so its CI linting is
#   blind to exactly the issues those rules catch (confirmed via a config-bypass run).
# ---------------------------------------------------------------------------
SEC_LINT = ("risky-file-permissions", "risky-shell-pipe", "no-log-password", "risky-octal")
lintcfg = os.path.join(ANSIBLE, ".ansible-lint")
if os.path.isfile(lintcfg):
    lines = readlines(lintcfg)
    in_skip = False
    for i, ln in enumerate(lines, 1):
        s = ln.strip()
        if re.match(r"(skip_list|warn_list)\s*:", s):
            in_skip = True; continue
        if in_skip and s and not s.startswith("-") and not s.startswith("#") and ":" in s:
            in_skip = False
        if in_skip and s.startswith("-"):
            rule = s.lstrip("- ").split("#")[0].strip().strip("'\"")
            if rule in SEC_LINT:
                add("CMS-SEC-10", "Security lint rule disabled in .ansible-lint", "MEDIUM", "ansible", lintcfg, i)


json.dump(findings, open(OUT, "w"), indent=1)
print(f"custom rules: {len(findings)} findings across {len({f['id'] for f in findings})} rule types -> {OUT}")
