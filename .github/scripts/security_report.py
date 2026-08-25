#!/usr/bin/env python3
"""
Merge Checkov + KICS into a structured run.json consumed by the public
security dashboard (.github/security-dashboard/index.html), plus a GitHub
step-summary card.

Findings are grouped by rule (distinct issue types with occurrence counts).
Each occurrence carries a root-relative path and a deep link to that exact line
on the scanned commit. Each rule carries a curated "why / how to fix".

Inputs (env): CHECKOV_JSON, KICS_JSON, OUT_JSON, REPO, REF, SHA, RUN_ID,
RUN_URL, PR_NUMBER, PR_TITLE, SCAN_SCOPE
"""
import json, os, datetime, collections

SEV_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
CHECKOV_SEV = {"secrets": "HIGH", "dockerfile": "MEDIUM", "ansible": "MEDIUM"}

# Curated "why it matters / how to fix / authoritative reference" keyed by a lowercase
# substring of the rule title (KICS) or the Checkov id prefix. First match wins; the
# ref overrides the scanner's own link (KICS sometimes points at dead legacy docs).
# Every rule KICS/Checkov actually emits for this stack is covered here, so the report
# stays specific and actionable even when the AI layer is unavailable.
_COMPOSE = "https://docs.docker.com/reference/compose-file/services/"
_OWASP = "https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html"
# Deep-linked to the exact rule/section that explains each issue, so readers land on
# the precise guidance rather than a page top.
_OWASP_SOCKET = _OWASP + "#rule-1-do-not-expose-the-docker-daemon-socket-even-to-the-containers"
_OWASP_CAPS = _OWASP + "#rule-3-limit-capabilities-grant-only-specific-capabilities-needed-by-a-container"
_OWASP_NNP = _OWASP + "#rule-4-prevent-in-container-privilege-escalation"
_OWASP_RES = _OWASP + "#rule-7-limit-resources-memory-cpu-file-descriptors-processes-restarts"
_OWASP_RO = _OWASP + "#rule-8-set-filesystem-and-volumes-to-read-only"
_PORT_BIND = "https://docs.docker.com/engine/network/port-publishing/#setting-the-default-bind-address-for-containers"
_ANSIBLE_URI = "https://docs.ansible.com/ansible/latest/collections/ansible/builtin/uri_module.html#parameter-validate_certs"
# References for the setup-specific custom rules (CMS-SEC-*).
_OWASP_SECRETS = "https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html"
_CWE_494 = "https://cwe.mitre.org/data/definitions/494.html"
_DOCKER_INSEC = "https://docs.docker.com/reference/cli/dockerd/#insecure-registries"
_ANSIBLE_HOSTKEY = "https://docs.ansible.com/ansible/latest/reference_appendices/config.html#host-key-checking"
_OWASP_HEADERS = "https://owasp.org/www-project-secure-headers/"
_SYSTEMD_EXEC = "https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#NoNewPrivileges="
_OWASP_ACCESS = "https://owasp.org/Top10/A01_2021-Broken_Access_Control/"
_UFW = "https://help.ubuntu.com/community/UFW"

REMEDIATION = [
    # ---- setup-specific custom rules (CMS-SEC-*), grounded in the live cms-pilot audit ----
    ("weak or default credential", (
        "A well-known default credential (e.g. eGov@123, minioadmin, egov123) is baked into the deployment. Unless every call site is overridden, admin/superuser/datastore accounts ship with a guessable password - trivial account takeover, and this repo is PUBLIC.",
        "Remove the hardcoded default: require the value from a vault/secret with no fallback (drop the `default('eGov@123')`), fail the deploy if unset, and rotate any credential that was ever deployed with the default.",
        _OWASP_SECRETS)),
    ("piped directly into a shell", (
        "A script is downloaded and executed in one step (curl ... | bash) as root, with no checksum or signature check. A compromised or MITM'd endpoint runs arbitrary code as root on every target - CWE-494 (download of code without integrity check).",
        "Download to a file, verify a pinned checksum/GPG signature, then execute; or install the package from a trusted, pinned apt/dnf repo. Never pipe a network response straight into a shell.",
        _CWE_494)),
    ("insecure http", (
        "Container images are pulled from a registry over plaintext HTTP with TLS verification disabled (insecure-registries). Images run with host-level privileges, so a MITM can substitute a malicious image and take over the host.",
        "Serve the registry over HTTPS with a valid certificate and remove it from `insecure-registries`. If a private CA is used, distribute the CA bundle instead of disabling TLS.",
        _DOCKER_INSEC)),
    ("host-key verification disabled", (
        "StrictHostKeyChecking=no (or host_key_checking=False) disables SSH server-identity verification for the deploy. A man-in-the-middle can impersonate the target and capture the root provisioning session and any secrets pushed to it.",
        "Remove StrictHostKeyChecking=no; pre-seed known_hosts (ssh-keyscan into a trusted file) and keep host key checking enabled. Use accept-new only for first-time bootstrap, never a blanket no.",
        _ANSIBLE_HOSTKEY)),
    ("security header", (
        "The public nginx edge for this citizen-facing government app does not set this security response header, leaving users exposed to protocol downgrade (no HSTS), MIME sniffing (no X-Content-Type-Options), clickjacking, or version disclosure (server_tokens on).",
        "Add the header in the nginx server block: `add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always;`, `add_header X-Content-Type-Options nosniff always;`, `add_header X-Frame-Options DENY always;`, and set `server_tokens off;`.",
        _OWASP_HEADERS)),
    ("without hardening", (
        "The systemd service runs without sandboxing - typically as root with no NoNewPrivileges/ProtectSystem. If the service (or a payload it runs) is compromised, there is nothing between it and full host control.",
        "Add to the unit's [Service] section: a non-root `User=`, `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, and `ReadWritePaths=` limited to what it needs.",
        _SYSTEMD_EXEC)),
    ("published on all interfaces", (
        "This datastore/admin port is published on 0.0.0.0 (all host interfaces). On the live server there is NO host firewall (ufw inactive), so the cloud security group is the ONLY control - a single point of failure guarding Postgres/Redis/Kafka/MinIO/Jupyter data.",
        "Bind the published port to loopback in compose, e.g. `- \"127.0.0.1:15432:5432\"`, so it is never on a public interface; reach it via the reverse proxy or an SSH tunnel. Add defense-in-depth with a host firewall (see the no-firewall finding).",
        _PORT_BIND)),
    ("unauthenticated admin", (
        "An admin/API surface (e.g. /mcp - mdms_create, user_create, tenant_bootstrap) is proxied at the public edge with no authentication. On the live cms-pilot tenant this is enabled and internet-reachable over 443 - unauthenticated privileged operations - OWASP A01 Broken Access Control.",
        "Put the location behind authentication (auth_basic, auth_request/JWT, or mTLS), or disable the block entirely on internet-facing tenants (keep `nginx_features.mcp` false in production). Never expose privileged admin verbs without auth.",
        _OWASP_ACCESS)),
    ("no host firewall", (
        "The playbook provisions a host that publishes ~33 service ports (incl. datastores) but configures no host firewall; on the live VM ufw is inactive, so only the cloud security group stands between those ports and the network. Any SG misconfiguration or a foothold on the host/VPC exposes everything.",
        "Add a host firewall to the playbook (ufw/nftables): default-deny inbound, allow only 22/80/443 from the internet, and restrict datastore/admin ports to loopback or an admin CIDR. Defense in depth alongside binding ports to 127.0.0.1.",
        _UFW)),
    # ---- semantic findings from the ansible-lint dry-run (config bypassed) ----
    ("explicit restrictive mode", (
        "The file/copy/template task creates a file without an explicit `mode:`, so it inherits the process umask. Config or secret material can land world-readable. The repo's own .ansible-lint suppresses this rule, so its CI never catches it.",
        "Add an explicit least-privilege `mode:` to the task, e.g. `mode: '0640'` for config and `mode: '0600'` for anything holding a secret; `mode: '0750'`/`'0700'` for directories.",
        "https://ansible.readthedocs.io/projects/lint/rules/risky-file-permissions/")),
    ("pipeline without pipefail", (
        "A shell task pipes commands without `set -o pipefail`, so a failure in any stage except the last is silently ignored - a failed download/verify can still be treated as success (masking supply-chain or deploy errors).",
        "Start the shell with `set -o pipefail` (and add `args: executable: /bin/bash`), or split the pipeline into discrete, checked steps.",
        "https://ansible.readthedocs.io/projects/lint/rules/risky-shell-pipe/")),
    ("leak a secret to logs", (
        "A task that handles a password/secret does not set `no_log: true`, so the secret can be printed to Ansible output / CI logs where it is retained and widely visible.",
        "Add `no_log: true` to any task that references a password, token, key, or other secret.",
        "https://ansible.readthedocs.io/projects/lint/rules/no-log-password/")),
    ("partial become", (
        "Privilege escalation is set inconsistently (become without become_user or vice-versa), which can run a task with unintended privileges.",
        "Set `become:` and `become_user:` together and explicitly; drop privileges (`become: false`) for tasks that do not need root.",
        "https://ansible.readthedocs.io/projects/lint/rules/partial-become/")),
    ("security lint rule disabled", (
        "The repo's `.ansible-lint` skip/warn list disables a security rule (e.g. risky-file-permissions), so the project's own linting is blind to that class of issue - a governance gap that lets insecure changes pass CI unnoticed.",
        "Remove the security rule from the skip_list (fix the underlying tasks instead), or move it to warn_list only with a documented, time-boxed justification. Keep security rules enforcing in CI.",
        "https://ansible.readthedocs.io/projects/lint/configuring/#pre-commit")),
    # ---- generic ansible / compose rules ----
    ("https url is used", (
        "Ansible `uri`/`get_url` tasks that call an http:// endpoint send data (including credentials, tokens and config) over the network in cleartext, exposing it to interception or man-in-the-middle tampering.",
        "Change the task's `url:` from `http://` to `https://`. If the target is an internal service without TLS, front it with a TLS-terminating proxy or document the exception - do not disable certificate validation to work around it.",
        _ANSIBLE_URI)),
    ("validate_certs", (
        "`validate_certs: false` turns off TLS certificate verification, so Ansible trusts any certificate presented. A man-in-the-middle can impersonate the endpoint and capture or alter what is sent.",
        "Remove `validate_certs: false` (the default `true` verifies certificates). For a private CA, set `ca_path: /path/to/ca-bundle.crt` on the task instead of disabling verification.",
        _ANSIBLE_URI)),
    ("certificate validation", (
        "Disabling TLS certificate validation lets Ansible trust any certificate, enabling man-in-the-middle interception of the request.",
        "Re-enable certificate validation (`validate_certs: true`) and supply the CA bundle via `ca_path:` if a private CA is in use.",
        _ANSIBLE_URI)),
    ("docker socket mounted", (
        "Mounting /var/run/docker.sock gives the container full control of the Docker daemon on the host - equivalent to root on the machine, so a compromised container can escape and take over the server.",
        "Remove the `- /var/run/docker.sock:/var/run/docker.sock` bind mount. If a container genuinely needs Docker access, put a scoped proxy (e.g. `tecnativa/docker-socket-proxy`) in front, exposing only the required API endpoints read-only.",
        _OWASP_SOCKET)),
    ("sensitive host directory", (
        "Bind-mounting a sensitive host path (`/`, `/etc`, `/var/run`, `/root`) lets the container read or modify host files, breaking isolation between the container and the server.",
        "Mount only the specific sub-directory the service needs, and add `:ro` to make it read-only (e.g. `- ./config:/app/config:ro`). Never mount host system directories.",
        _OWASP_RO)),
    ("capabilities unrestricted", (
        "Containers run with a default set of Linux capabilities (e.g. NET_RAW, CHOWN, SETUID) that most services never use. Any extra capability widens what a compromised process can do on the host kernel.",
        "Drop everything and re-add only what the service needs: add `cap_drop: [ALL]` to each service, then `cap_add: [...]` for the few capabilities it genuinely requires (often none). Apply this pattern across the compose services flagged.",
        _OWASP_CAPS)),
    ("security opt", (
        "Without `no-new-privileges`, a process in the container can escalate via setuid binaries; without an seccomp/AppArmor profile it can make syscalls it never needs, enlarging the kernel attack surface.",
        "Add `security_opt: [\"no-new-privileges:true\"]` to each service (keep the default seccomp profile - do not set `seccomp:unconfined`).",
        _OWASP_NNP)),
    ("privileged port", (
        "Mapping a privileged host port (below 1024) forces the daemon/container to bind with elevated privileges, widening the attack surface.",
        "Map the service to a high host port (>=1024), e.g. `- \"8080:8080\"`, and let the reverse proxy terminate 80/443, so containers never bind privileged ports.",
        _COMPOSE + "#ports")),
    ("privileged container", (
        "A privileged container disables most isolation (all capabilities, device access) - a container escape becomes trivial.",
        "Remove `privileged: true`. Grant only the specific Linux capabilities the workload needs via `cap_add`, and drop the rest with `cap_drop: [ALL]`.",
        _COMPOSE + "#privileged")),
    ("host namespace", (
        "Sharing a host namespace (`pid`, `ipc`, or `network`) removes the isolation boundary: the container can see and signal host processes, access host IPC, or bind every host interface.",
        "Remove `pid: host` / `ipc: host` / `network_mode: host` from the service. Use a user-defined bridge network and publish only the ports you need.",
        _COMPOSE + "#pid")),
    ("host network", (
        "Sharing the host network namespace removes network isolation and exposes all host interfaces/ports to the container.",
        "Remove `network_mode: host`. Use a user-defined bridge network and publish only the ports you need.",
        _COMPOSE + "#network_mode")),
    ("not bound to host interface", (
        "Publishing a port on 0.0.0.0 exposes the service on every network interface of the host, including public ones.",
        "Bind the published port to loopback or a specific private interface, e.g. `- \"127.0.0.1:5432:5432\"`, and expose it externally only through the reverse proxy.",
        _PORT_BIND)),
    ("shared volumes", (
        "A named/host volume mounted into more than one container lets a compromise in one service read or tamper with another service's data, and can leak secrets written to that volume across trust boundaries.",
        "Give each service its own volume unless sharing is required. Where a volume must be shared, mount it read-only (`:ro`) in every consumer that does not need to write.",
        _OWASP_RO)),
    ("no new privileges", (
        "Without no-new-privileges, a process inside the container can gain additional privileges via setuid binaries.",
        "Add `security_opt: [\"no-new-privileges:true\"]` to the service.",
        _OWASP_NNP)),
    ("read-only", (
        "A writable root filesystem lets an attacker drop tools or tamper with binaries inside the container.",
        "Set `read_only: true` and mount explicit writable volumes only where the app must write (e.g. `tmpfs: [/tmp]`).",
        _OWASP_RO)),
    ("healthcheck", (
        "Without a healthcheck the orchestrator cannot tell if the container is actually serving, so failed containers keep receiving traffic.",
        "Add a `healthcheck:` block that probes a real readiness endpoint, e.g. `test: [\"CMD\", \"curl\", \"-f\", \"http://localhost:8080/health\"]` with sensible `interval`/`retries`.",
        _COMPOSE + "#healthcheck")),
    ("memory", (
        "Without a memory limit a single container can exhaust host RAM and take down every other service (DoS).",
        "Set a memory limit for the service, e.g. `mem_limit: 512m` (or `deploy.resources.limits.memory` under Swarm).",
        _OWASP_RES)),
    ("cpu", (
        "Without a CPU limit one container can starve every other service on the host.",
        "Set a CPU limit for the service, e.g. `cpus: \"1.5\"` (or `deploy.resources.limits.cpus`).",
        _OWASP_RES)),
    ("ckv_secret", (
        "A credential (password, token, key) appears to be committed to the repository. Anyone with read access - and this repo is public - can use it.",
        "Remove the secret from the file, rotate/revoke it immediately, and inject it at runtime via an environment variable or secret store. Enable GitHub secret scanning + push protection.",
        _OWASP)),
    ("passwords and secrets", (
        "A value matching a credential pattern was found in infrastructure code. If real, it is exposed to everyone with repo access.",
        "Confirm whether it is a real secret; if so rotate it and move it to a runtime secret/env var. If it is a non-secret default, ignore or suppress the rule.",
        _OWASP)),
    ("ckv_docker", (
        "The Dockerfile diverges from a hardening best practice (e.g. missing HEALTHCHECK, running as root).",
        "Apply the specific Dockerfile fix (add HEALTHCHECK, add a non-root USER, pin base image digests).",
        "https://docs.docker.com/develop/security-best-practices/")),
    ("ckv_ansible", (
        "The Ansible task weakens security (e.g. TLS validation disabled, permissive file mode).",
        "Re-enable `validate_certs: true`, tighten file `mode`, and avoid `become` where not required.",
        _ANSIBLE_URI)),
]


def load(p):
    if p and os.path.exists(p):
        try:
            return json.load(open(p))
        except Exception:
            return None
    return None


def norm_sev(s):
    s = (s or "").upper()
    return "INFO" if s == "TRACE" else (s if s in SEV_ORDER else "MEDIUM")


def remediate(rule_id, title, desc):
    """Returns (why, fix, curated, ref). curated=True means it came from the vetted
    map and must NOT be overwritten by LLM enrichment. ref is an authoritative doc
    URL (or "" to keep the scanner's own link)."""
    key = (title or "").lower() + " " + (rule_id or "").lower()
    for needle, item in REMEDIATION:
        if needle in key:
            why, fix = item[0], item[1]
            ref = item[2] if len(item) > 2 else ""
            return why, fix, True, ref
    return (desc or "This configuration diverges from a security best practice."), \
           "Follow the reference for this rule to apply the fix; the AI layer adds a code-specific fix when enabled.", False, ""


def category(title):
    """Normalized category used only for cross-scanner de-duplication. Returns
    None for rules we never collapse across scanners."""
    t = (title or "").lower()
    if any(w in t for w in ("password", "secret", "token", "encryption key",
                            "private key", "access key", "basic auth",
                            "high entropy", "credential")):
        return "secret"
    return None


# Security domain used to group findings in the audit workbook and dashboard.
# First substring match wins; keep aligned with the REMEDIATION needles.
SEC_CATEGORY = [
    (("docker socket", "sensitive host directory", "privileged container", "capabilities",
      "host namespace", "host network", "host pid", "host ipc"), "Container Isolation & Escape"),
    (("security opt", "no new privileges", "read-only", "read only", "seccomp", "apparmor",
      "without hardening", "systemd", "security lint rule disabled"), "Host & Service Hardening"),
    (("restrictive mode", "file permission", "insecure permission"), "File Permissions"),
    (("partial become", "privilege escalation"), "Access Control"),
    (("piped directly into a shell", "insecure http", "registry used over insecure",
      "integrity check", "pipefail"), "Supply Chain & Integrity"),
    (("host-key verification", "unauthenticated admin", "admin/api surface", "broken access"), "Access Control"),
    (("security header", "server_tokens", "hsts", "clickjacking"), "Web & Edge Hardening"),
    (("not bound to host interface", "privileged port", "0.0.0.0", "exposed port",
      "published on all interfaces", "no host firewall", "firewall"), "Network Exposure"),
    (("https url", "validate_certs", "certificate validation", "tls", "ssl"), "Transport Security (TLS)"),
    (("secret", "password", "token", "credential", "private key", "access key"), "Secrets Management"),
    (("memory", "cpu", "healthcheck", "ulimit", "pids limit", "restart"), "Resource & Availability Controls"),
    (("shared volume", "shared volumes"), "Data Sharing"),
]


def sec_category(rule_id, title):
    key = (title or "").lower() + " " + (rule_id or "").lower()
    for needles, name in SEC_CATEGORY:
        if any(n in key for n in needles):
            return name
    return "General Hardening"


def from_checkov(data):
    # Checkov reports paths relative to the scanned directory. Prepend CHECKOV_BASE
    # so paths are repo-root-relative (correct display + working blob links).
    base = os.environ.get("CHECKOV_BASE", "").strip("/")
    out = []
    for r in (data if isinstance(data, list) else [data]) if data else []:
        ct = r.get("check_type", "checkov")
        for c in ((r.get("results") or {}).get("failed_checks") or []):
            fp = (c.get("file_path") or "").lstrip("/")
            if base and fp and not fp.startswith(base + "/"):
                fp = f"{base}/{fp}"
            out.append({"source": "Checkov", "area": ct, "severity": CHECKOV_SEV.get(ct, "MEDIUM"),
                        "id": c.get("check_id", ""), "title": c.get("check_name", ""),
                        "file": fp,
                        "line": (c.get("file_line_range") or [None])[0],
                        "desc": "", "guide": c.get("guideline") or ""})
    return out


def from_kics(data):
    out = []
    for q in ((data or {}).get("queries") or []):
        for f in (q.get("files") or []):
            out.append({"source": "KICS", "area": "docker-compose", "severity": norm_sev(q.get("severity")),
                        "id": q.get("query_id", "") or q.get("query_name", ""), "title": q.get("query_name", ""),
                        "file": (f.get("file_name") or "").lstrip("/"), "line": f.get("line"),
                        "desc": q.get("description", ""), "guide": q.get("query_url") or ""})
    return out


def from_custom(data):
    """Setup-specific findings emitted by custom_rules.py (already root-relative)."""
    out = []
    for f in (data or []):
        out.append({"source": f.get("source", "Custom"), "area": f.get("area", "ansible"),
                    "severity": norm_sev(f.get("severity")), "id": f.get("id", ""),
                    "title": f.get("title", ""), "file": (f.get("file") or "").lstrip("/"),
                    "line": f.get("line"), "desc": f.get("desc", ""), "guide": f.get("guide") or ""})
    return out


def blob(repo, sha, path, line):
    u = f"https://github.com/{repo}/blob/{sha}/{path}"
    return u + (f"#L{line}" if line else "")


def main():
    meta_repo = os.environ.get("REPO", "org/repo")
    sha = os.environ.get("SHA", "")
    findings = (from_checkov(load(os.environ.get("CHECKOV_JSON")))
                + from_kics(load(os.environ.get("KICS_JSON")))
                + from_custom(load(os.environ.get("CUSTOM_JSON"))))

    # Supersede: the setup-specific datastore-exposure rule (CMS-SEC-07, High) is more
    # specific and actionable than KICS's generic "not bound to host interface" (Medium).
    # KICS anchors the `ports:` block ~1-3 lines above the individual entry CMS-SEC-07
    # flags (verified against real output), so drop the KICS occurrence when a CMS-SEC-07
    # datastore line falls in a small forward window of the KICS line, in the same file.
    ds_lines = {}
    for f in findings:
        if f.get("id") == "CMS-SEC-07" and f.get("line"):
            ds_lines.setdefault(f["file"], set()).add(f["line"])

    def _superseded(f):
        if f.get("source") != "KICS" or "not bound to host interface" not in (f.get("title") or "").lower():
            return False
        ln = f.get("line")
        return bool(ln) and any((ln + d) in ds_lines.get(f["file"], ()) for d in (0, 1, 2, 3))

    findings = [f for f in findings if not _superseded(f)]

    # Deterministic cross-scanner de-dupe: if two DIFFERENT scanners flag the same
    # (file, line) for the same category (e.g. a secret), keep one - highest severity,
    # Checkov preferred for secrets (its dedicated scanner). Within one scanner, keep all.
    buckets = {}
    for f in findings:
        cat = category(f["title"])
        if cat is None:
            continue
        buckets.setdefault((f["file"], f["line"], cat), []).append(f)
    drop = set()
    for items in buckets.values():
        if len({i["source"] for i in items}) > 1:
            keep_first = sorted(items, key=lambda i: (SEV_ORDER.index(i["severity"]),
                                                      0 if i["source"] == "Checkov" else 1))
            for i in keep_first[1:]:
                drop.add(id(i))
    findings = [f for f in findings if id(f) not in drop]

    groups = {}
    for f in findings:
        k = (f["severity"], f["source"], f["id"], f["title"])
        g = groups.setdefault(k, {"severity": f["severity"], "source": f["source"], "area": f["area"],
                                  "id": f["id"], "title": f["title"], "guide": f["guide"],
                                  "locations": [], "_desc": f.get("desc", "")})
        if f["file"]:
            g["locations"].append({"path": f["file"], "line": f["line"],
                                   "url": blob(meta_repo, sha, f["file"], f["line"])})
    grouped = []
    for g in groups.values():
        why, fix, curated, ref = remediate(g["id"], g["title"], g.pop("_desc", ""))
        g["why"], g["fix"], g["curated"], g["count"] = why, fix, curated, len(g["locations"])
        g["category"] = sec_category(g["id"], g["title"])
        # Prefer a vetted authoritative reference over the scanner's own link,
        # which can point at dead/legacy documentation.
        if ref:
            g["guide"] = ref
        grouped.append(g)
    order = {s: i for i, s in enumerate(SEV_ORDER)}
    grouped.sort(key=lambda g: (order.get(g["severity"], 9), -g["count"]))

    types_by = collections.Counter(g["severity"] for g in grouped)
    occ_by = collections.Counter(f["severity"] for f in findings)
    pr = None
    if os.environ.get("PR_NUMBER"):
        n = os.environ["PR_NUMBER"]
        pr = {"number": int(n), "title": os.environ.get("PR_TITLE", ""),
              "url": f"https://github.com/{meta_repo}/pull/{n}"}

    run = {
        "meta": {
            "repo": meta_repo, "branch": os.environ.get("REF", ""), "sha": sha, "shaShort": sha[:7],
            "runId": os.environ.get("RUN_ID", ""), "runUrl": os.environ.get("RUN_URL", "#"),
            "pr": pr, "scope": os.environ.get("SCAN_SCOPE", "Ansible Deployment - Remote Server"),
            "scanners": ["Checkov", "KICS", "Custom rules"],
            "date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        },
        "summary": {"types": len(grouped), "occurrences": len(findings),
                    "typesBySeverity": {s: types_by.get(s, 0) for s in SEV_ORDER},
                    "occBySeverity": {s: occ_by.get(s, 0) for s in SEV_ORDER}},
        "findings": grouped,
    }
    json.dump(run, open(os.environ.get("OUT_JSON", "run.json"), "w"), indent=1)

    # step summary
    prio = [g for g in grouped if g["severity"] in ("CRITICAL", "HIGH")]
    print("## 🛡️ Security Scan — Ansible Remote Server Deployment\n")
    if not findings:
        print("**✅ No findings in scope.**")
    else:
        chips = "  ".join(f"**{s.title()}** {types_by[s]}" for s in SEV_ORDER if types_by.get(s))
        print(f"**{len(grouped)} issue types** across {len(findings)} occurrences  ·  {chips}\n")
        if prio:
            print("### Priority (High & Critical)\n| Severity | Issue | Count |\n|---|---|--:|")
            for g in prio[:15]:
                print(f"| {g['severity'].title()} | `{g['id']}` {g['title'][:56]} | {g['count']} |")
        print("\n📊 **Public dashboard:** see the workflow-run link in the PR, or the Pages URL. "
              "Per-location triage: **Security → Code scanning**.")


if __name__ == "__main__":
    main()
