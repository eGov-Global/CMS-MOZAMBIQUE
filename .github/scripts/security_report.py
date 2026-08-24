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
_ANSIBLE_URI = "https://docs.ansible.com/ansible/latest/collections/ansible/builtin/uri_module.html#parameter-validate_certs"

REMEDIATION = [
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
        _OWASP)),
    ("sensitive host directory", (
        "Bind-mounting a sensitive host path (`/`, `/etc`, `/var/run`, `/root`) lets the container read or modify host files, breaking isolation between the container and the server.",
        "Mount only the specific sub-directory the service needs, and add `:ro` to make it read-only (e.g. `- ./config:/app/config:ro`). Never mount host system directories.",
        _COMPOSE + "#volumes")),
    ("capabilities unrestricted", (
        "Containers run with a default set of Linux capabilities (e.g. NET_RAW, CHOWN, SETUID) that most services never use. Any extra capability widens what a compromised process can do on the host kernel.",
        "Drop everything and re-add only what the service needs: add `cap_drop: [ALL]` to each service, then `cap_add: [...]` for the few capabilities it genuinely requires (often none). Apply this pattern across the compose services flagged.",
        _COMPOSE + "#cap_drop")),
    ("security opt", (
        "Without `no-new-privileges`, a process in the container can escalate via setuid binaries; without an seccomp/AppArmor profile it can make syscalls it never needs, enlarging the kernel attack surface.",
        "Add `security_opt: [\"no-new-privileges:true\"]` to each service (keep the default seccomp profile - do not set `seccomp:unconfined`).",
        _COMPOSE + "#security_opt")),
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
        _COMPOSE + "#ports")),
    ("shared volumes", (
        "A named/host volume mounted into more than one container lets a compromise in one service read or tamper with another service's data, and can leak secrets written to that volume across trust boundaries.",
        "Give each service its own volume unless sharing is required. Where a volume must be shared, mount it read-only (`:ro`) in every consumer that does not need to write.",
        _OWASP)),
    ("no new privileges", (
        "Without no-new-privileges, a process inside the container can gain additional privileges via setuid binaries.",
        "Add `security_opt: [\"no-new-privileges:true\"]` to the service.",
        _COMPOSE + "#security_opt")),
    ("read-only", (
        "A writable root filesystem lets an attacker drop tools or tamper with binaries inside the container.",
        "Set `read_only: true` and mount explicit writable volumes only where the app must write (e.g. `tmpfs: [/tmp]`).",
        _COMPOSE + "#read_only")),
    ("healthcheck", (
        "Without a healthcheck the orchestrator cannot tell if the container is actually serving, so failed containers keep receiving traffic.",
        "Add a `healthcheck:` block that probes a real readiness endpoint, e.g. `test: [\"CMD\", \"curl\", \"-f\", \"http://localhost:8080/health\"]` with sensible `interval`/`retries`.",
        _COMPOSE + "#healthcheck")),
    ("memory", (
        "Without a memory limit a single container can exhaust host RAM and take down every other service (DoS).",
        "Set a memory limit for the service, e.g. `mem_limit: 512m` (or `deploy.resources.limits.memory` under Swarm).",
        _COMPOSE + "#mem_limit")),
    ("cpu", (
        "Without a CPU limit one container can starve every other service on the host.",
        "Set a CPU limit for the service, e.g. `cpus: \"1.5\"` (or `deploy.resources.limits.cpus`).",
        _COMPOSE + "#cpus")),
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
    (("security opt", "no new privileges", "read-only", "read only", "seccomp", "apparmor"), "Container Hardening"),
    (("not bound to host interface", "privileged port", "0.0.0.0", "exposed port"), "Network Exposure"),
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


def blob(repo, sha, path, line):
    u = f"https://github.com/{repo}/blob/{sha}/{path}"
    return u + (f"#L{line}" if line else "")


def main():
    meta_repo = os.environ.get("REPO", "org/repo")
    sha = os.environ.get("SHA", "")
    findings = from_checkov(load(os.environ.get("CHECKOV_JSON"))) + from_kics(load(os.environ.get("KICS_JSON")))

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
            "scanners": ["Checkov", "KICS"],
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
