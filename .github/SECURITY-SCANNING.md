# Security Scanning - Deployment Option C

Automated security scanning scoped to **Option C** of the
[three setup paths](../local-setup/#choose-your-setup-path): `./deploy.sh <tenant>` -
Ansible configures a remote Ubuntu box and runs the docker-compose stack.

Runs in CI as **`.github/workflows/security-scan.yml`**.

## What is scanned (and by which tool)

| Tool | Covers | Option C surface |
|------|--------|------------------|
| **Checkov** | Ansible, Dockerfiles, secrets | `local-setup/ansible/**`, built images, `host_vars` credentials |
| **KICS** | **docker-compose** (with severities) | published ports, `privileged`, host-network, protocols in the compose files the deploy runs |

**Explicitly excluded** (other setup paths / later phases): `local-setup/k8s/**`
(Kubernetes/Tilt) and `devops/**` (Helm charts + Terraform). These produced the large
`CKV_K8S_*` counts and are not part of Option C.

### Later phases
- Phase 2: Kubernetes path (`local-setup/k8s/**`) + Helm charts.
- Phase 3: Terraform / cloud infra (`devops/infra-as-code/terraform/**`).

## Where to view results (3 surfaces, by audience)

1. **Executive HTML report - for management / PM / tech leads.**
   Every run produces a self-contained, printable **`security-report`** artifact
   (download it from the run's *Artifacts* section, or Actions run page). It opens in any
   browser and prints cleanly to PDF: risk posture, severity breakdown, findings by area,
   and remediation - no GitHub knowledge needed.
2. **Run summary card** - a condensed severity table on each workflow run page (quick glance).
3. **Security -> Code scanning tab** - for engineers: filterable, groupable, dismissable
   findings with inline PR annotations. Both tools upload here (categories `checkov`, `kics`).

## Reading the numbers
- **Passed / Failed** = each policy is evaluated against each resource; failed = that resource
  violates the policy. Counts are policy-vs-resource evaluations, not distinct bugs.
- **Severity**: KICS assigns native Critical/High/Medium/Low. Checkov (OSS) does not emit
  severities, so in the merged report its findings are bucketed conservatively
  (secrets = High, other = Medium).
- The run's **Annotations** panel caps at ~10 lines - a display limit, not the total.

## When it runs
Every pull request; pushes to `master` / `develop`; weekly (Mon 03:00 UTC); and on demand
(**Actions -> Security Scan (Option C) -> Run workflow**).

## Enforcement (currently report-only)
`soft-fail: true` in `.checkov.yaml` and `fail_on: ""` for KICS report without blocking.
To enforce after triage: set `soft-fail: false` (Checkov) and `fail_on: high` (KICS), then add
**"Option C security scan"** as a required status check in branch protection.

## Run locally
```bash
pip install checkov
checkov -d .                                   # Checkov, Option C scope (.checkov.yaml)
docker run -t -v "$PWD:/path" checkmarx/kics:latest scan -p /path -t DockerCompose \
  --exclude-paths /path/local-setup/k8s,/path/devops   # KICS, compose only
```

## Not covered: application-code logic
Checkov and KICS scan configuration, not Java/Node application-logic bugs. For that, enable
GitHub's free **CodeQL default setup** (*Settings -> Code security -> Code scanning*).
