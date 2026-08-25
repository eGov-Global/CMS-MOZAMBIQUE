#!/usr/bin/env python3
"""
Convert ansible-lint SARIF output into security findings for the report pipeline.

We run ansible-lint in the CI "dry-run" job with the repo config bypassed (-c /dev/null)
so security rules the repo's own .ansible-lint suppresses (risky-file-permissions, etc.)
are re-enabled. Only SECURITY-relevant rules are kept - this is a semantic check
(ansible-lint understands modules/args), not a raw-file grep.

Findings are APPENDED to OUT (custom.json) in the same shape security_report.py consumes.

Env: SARIF (default lint.sarif), OUT (default custom.json),
     ANSIBLE_PREFIX (repo-root path of the ansible dir, default local-setup/ansible)
"""
import os, json

SARIF = os.environ.get("SARIF", "lint.sarif")
OUT = os.environ.get("OUT", "custom.json")
PREFIX = os.environ.get("ANSIBLE_PREFIX", "local-setup/ansible").strip("/")
DOC = "https://ansible.readthedocs.io/projects/lint/rules/"

# ansible-lint ruleId -> (human title, severity). Only security-relevant rules.
RULES = {
    "risky-file-permissions": ("File created without an explicit restrictive mode", "MEDIUM"),
    "risky-shell-pipe":       ("Shell pipeline without pipefail (failures go undetected)", "MEDIUM"),
    "no-log-password":        ("Task may leak a secret to logs (no_log not set)", "HIGH"),
    "partial-become":         ("Inconsistent privilege escalation (partial become)", "LOW"),
}


def rel(uri):
    uri = (uri or "").replace("file://", "").lstrip("./").lstrip("/")
    if uri and not uri.startswith(PREFIX + "/") and not uri.startswith("local-setup/"):
        uri = f"{PREFIX}/{uri}"
    return uri


def main():
    try:
        sar = json.load(open(SARIF))
    except Exception as e:
        print(f"no/invalid sarif ({e}); skipping ansible-lint findings.")
        return
    results = (sar.get("runs") or [{}])[0].get("results", [])
    out = []
    for r in results:
        rid = (r.get("ruleId") or "").split("[")[0]
        if rid not in RULES:
            continue
        title, sev = RULES[rid]
        loc = ((r.get("locations") or [{}])[0].get("physicalLocation") or {})
        uri = rel((loc.get("artifactLocation") or {}).get("uri"))
        line = (loc.get("region") or {}).get("startLine")
        if not uri:
            continue
        out.append({"source": "ansible-lint", "area": "ansible", "severity": sev,
                    "id": rid, "title": title, "file": uri, "line": line,
                    "desc": "", "guide": f"{DOC}{rid}/"})

    existing = []
    if os.path.exists(OUT):
        try: existing = json.load(open(OUT))
        except Exception: existing = []
    json.dump(existing + out, open(OUT, "w"), indent=1)
    print(f"ansible-lint: added {len(out)} security finding(s) to {OUT} "
          f"(total {len(existing) + len(out)}).")


if __name__ == "__main__":
    main()
