# Security scan scope - Ansible remote-server deployment

This document records **which files the security scans treat as in-scope**, and
why. The scanners target one deployment path only: the Ansible remote-server
deployment described in `local-setup/README.md` (Option C - `./deploy.sh <tenant>`,
run from `local-setup/ansible`). Files that belong to other paths (Kubernetes/Helm,
Tilt/local-dev) are out of scope: a vulnerability in code the deployment never runs
is noise, not signal.

The scope below is not hand-guessed. It was derived by grepping the Ansible layer
and the compose files it invokes for the files and directories they actually
reference (task/template references + `./<dir>` bind mounts). Reproduce it with the
commands in the "How this was derived" section.

## In scope

**Deployment code**
- `local-setup/ansible/**` - the playbook, tasks, templates, `deploy.sh`,
  inventory, filter plugins. This is the deployment itself.

**Compose stacks the playbook invokes** (ref counts from `ansible/tasks` + `templates`):
| File | refs |
| --- | --- |
| `local-setup/docker-compose.egov-digit.yaml` | 26 (core stack) |
| `local-setup/docker-compose.fast-path.yml` | 6 |
| `local-setup/docker-compose.bomet.yml` | 5 (tenant overlay) |
| `local-setup/docker-compose.monitoring.yml` | 4 |
| `local-setup/docker-compose.migrations.yml` | 3 |
| `local-setup/docker-compose.matomo.yml` | 2 |

**Config trees mounted by those stacks or copied by the playbook**
- `local-setup/configs/`  (compose bind mount)
- `local-setup/db/`       (compose bind mount)
- `local-setup/gatus/`    (ansible + compose)
- `local-setup/jupyter/`  (compose bind mount)
- `local-setup/keycloak/` (ansible + compose)
- `local-setup/kong/`     (ansible + compose)
- `local-setup/nginx/`    (ansible + compose)
- `local-setup/otel/`     (compose bind mount - 22 refs, the observability config)
- `local-setup/seeds/`    (compose bind mount)
- `local-setup/tests/`    (ansible references it 10x; it is part of the deploy flow)

## Out of scope (and why)

| Path | Reason |
| --- | --- |
| `local-setup/k8s/` | Kubernetes/Helm path. Zero executable references - only appears in explanatory comments inside `playbook-deploy.yml`. |
| `Tiltfile`, `Tiltfile.*` | Tilt local-dev orchestration, not used by the remote-server deploy. |
| `docker-compose.core.yml`, `.deploy.yaml`, `.db-migrations.yml`, `.registry.yml`, `.tilt.yml`, `docker-compose.yml` (base) | Tilt/k8s/local-dev compose variants the playbook never invokes. |
| `local-setup/docker/` | Not a bind mount. The only `docker/` hits are `/var/lib/docker/containers` (host log path) and a CCRS-repo Dockerfile comment. |
| `local-setup/data/` | Not a bind mount. `data/` hits are container-internal paths (`/data/db`, `/data/import`) and named volumes. |
| `local-setup/keycloak-realms/`, `local-setup/scripts/`, `local-setup/postman/`, `local-setup/telemetry/` | Zero references from the deployed compose files or the Ansible layer. |
| Anything outside `local-setup/` (e.g. `Citizen-Complaint-Resolution-System/`) | Application source, built as an image; not deployment configuration. |

## How this is enforced

- **Checkov** is already scoped to `local-setup/ansible` (workflow `directory:`).
- **KICS** excludes `local-setup/k8s,devops,tests,node_modules`.
- **Custom rules** run deterministically against known deployment files only.
- **Strix** scans `./local-setup` broadly, so its findings are filtered
  post-hoc by `.github/scripts/strix_to_findings.py`: any finding whose validated
  file path is not in the in-scope set above is dropped, and the drop is logged.

## How this was derived (reproduce)

```sh
cd local-setup
FILES="docker-compose.egov-digit.yaml docker-compose.fast-path.yml \
docker-compose.bomet.yml docker-compose.monitoring.yml \
docker-compose.migrations.yml docker-compose.matomo.yml"

# compose files the ansible layer names
grep -rhoE "docker-compose\.[a-z.-]+\.ya?ml" ansible | sort | uniq -c | sort -rn

# host dirs bind-mounted by those compose files
for f in $FILES; do grep -hoE "\./[A-Za-z0-9._/-]+" "$f"; done \
  | sed -E 's#^\./##; s#/.*##' | sort | uniq -c | sort -rn

# confirm k8s has no executable references
grep -rniE "k8s|kubectl|helm|tilt" ansible | grep -viE "\.md:|readme|runbook|docs/"
```

Re-run these if the deployment topology changes (new compose stack, new mounted
config dir) and update both the table above and `SCOPE_DIRS`/`SCOPE_FILES` in
`.github/scripts/strix_to_findings.py`.
