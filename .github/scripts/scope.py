#!/usr/bin/env python3
"""
Single source of truth for the Ansible remote-server deployment scan scope.

Only files the Ansible deployment actually uses are in scope (see
.github/SECURITY-SCOPE.md). Everything else - the Kubernetes/Helm path, Tilt /
local-dev compose variants, unused config trees, and application source under
backend/ or turbopass/ - is out of scope: a finding in code the deployment never
runs is noise, not signal.

Used as a post-filter by security_report.py (covers Checkov / KICS / custom /
ansible-lint) and by strix_to_findings.py, so EVERY scanner is scoped the same
way. KICS in particular scans the whole tree (path: "."), so without this filter
~45% of reported occurrences came from out-of-scope compose files.

in_scope() is deliberately tolerant of the two path shapes scanners emit: a
repo-relative path with the `local-setup/` prefix (KICS, Checkov, custom rules)
and a bare compose filename without it.
"""
import os

# In-scope compose stacks the playbook invokes (bare basenames; matched with or
# without a leading local-setup/).
SCOPE_COMPOSE = {
    "docker-compose.egov-digit.yaml",
    "docker-compose.fast-path.yml",
    "docker-compose.bomet.yml",
    "docker-compose.monitoring.yml",
    "docker-compose.migrations.yml",
    "docker-compose.matomo.yml",
}

# In-scope directories under local-setup/ (the deployment code + the config trees
# those compose stacks mount / the playbook copies).
SCOPE_SUBDIRS = (
    "ansible/", "configs/", "db/", "gatus/", "jupyter/",
    "keycloak/", "kong/", "nginx/", "otel/", "seeds/", "tests/",
)


def in_scope(relpath):
    """True if a repo path belongs to the Ansible remote-server deployment set.

    Explicitly OUT of scope (returns False): local-setup/k8s, the base
    docker-compose.yml and the .deploy/.registry/.db-migrations/.tilt variants,
    and anything under backend/ or turbopass/ (application source)."""
    p = (relpath or "").replace("\\", "/").lstrip("./")
    if not p:
        return False
    # Compare within the setup root: drop a leading local-setup/ if present.
    q = p[len("local-setup/"):] if p.startswith("local-setup/") else p
    if "/" not in q:
        # a file sitting directly in local-setup/ (or a bare filename) - only the
        # in-scope compose stacks qualify; the base docker-compose.yml and the
        # .deploy/.registry/.tilt/.db-migrations variants are excluded here.
        return q in SCOPE_COMPOSE
    return any(q.startswith(d) for d in SCOPE_SUBDIRS)
