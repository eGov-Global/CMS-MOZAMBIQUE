# Security Scanning (Checkov)

Automated, full-repo security scanning run in CI with a single tool: **Checkov**.

## What it scans

| Area | Paths |
|------|-------|
| Terraform | `devops/infra-as-code/terraform/**` |
| Helm charts | `devops/deploy-as-code/charts/**`, `digit-mcp/helm/**` |
| Kubernetes manifests | static / rendered k8s YAML |
| Dockerfiles | `build/**`, `backend/**`, service dirs |
| docker-compose | `./docker-compose.*.y*ml`, `local-setup/**` |
| Ansible | `local-setup/ansible/**`, `performance/ansible/**` |
| GitHub Actions | `.github/workflows/**` |
| Secrets | all files (tokens, keys, passwords) |

Typical findings for this repo: security-group rules open to `0.0.0.0/0`,
container ports published on `0.0.0.0`, `privileged` / host-network containers,
images running as root, `latest` tags, `validate_certs: false` in Ansible,
missing Helm/K8s resource limits and securityContext, and committed secrets.

## When it runs
- Every pull request
- Every push to `master` / `develop`
- Weekly (Monday 03:00 UTC)
- On demand: **Actions -> Security Scan (Checkov) -> Run workflow**

## Where results go
The **Security -> Code scanning** tab (results uploaded as SARIF). Each finding
shows the file, line, policy ID, severity, and remediation guidance.

## Enforcement (currently report-only)
`soft-fail: true` in `.checkov.yaml` means findings are reported but do **not**
fail the build, so pre-existing issues don't block every PR from day one.

To start enforcing after triage:
1. Review current findings in the Security tab.
2. Either add a baseline so only **new** issues fail:
   ```bash
   checkov -d . --create-baseline .checkov.baseline
   # then add:  baseline: .checkov.baseline   to .checkov.yaml
   ```
   or set `soft-fail: false` in `.checkov.yaml` to fail on any finding.
3. Add **"Checkov full-repo scan"** as a required status check in branch protection.

## Run locally
```bash
pip install checkov
checkov -d .          # automatically picks up .checkov.yaml
```

## Not covered: application-code logic
Checkov scans configuration and secrets, not Java/Node application-logic bugs
(SQLi, SSRF, deserialization, etc.). To cover those without adding another tool
to maintain, enable GitHub's free **CodeQL default setup**
(*Settings -> Code security -> Code scanning -> Set up*) - it is native to GitHub
and complements Checkov.
