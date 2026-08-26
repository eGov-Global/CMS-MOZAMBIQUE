# Security Scanning - Ansible Remote Server Deployment

Security scanning for the Ansible remote-server deployment path
([setup path C](../local-setup/#choose-your-setup-path): `./deploy.sh <tenant>`).
Runs in CI as `.github/workflows/security-scan.yml` and publishes a public dashboard.

## What runs

| Tool | Scope |
|------|-------|
| **Checkov** | Ansible deployment code (`local-setup/ansible`) - config hardening (`.checkov.yaml`) |
| **KICS** | `docker-compose` files - exposed ports, protocols, privileged, host-network, host mounts (native severities) |
| **Ansible dry-run** | `ansible-playbook --syntax-check` + `ansible-lint` run with the repo config **bypassed** (`-c /dev/null`) so the security rules the repo's own `.ansible-lint` suppresses (`risky-file-permissions`, `risky-shell-pipe`, `no-log-password`) are re-enabled and fed into the report |
| **Custom rules** (`custom_rules.py`) | Setup-specific, high-signal checks derived from a review of the ansible code **and a read-only audit of the live cms-pilot VM**: datastore/admin ports on `0.0.0.0` (no host firewall), weak default credentials, `curl \| bash`, insecure registry, disabled SSH host-key checking, missing nginx security headers, unauthenticated `/mcp`, no host firewall, unhardened systemd units, suppressed security-lint config |
| **Strix** (AI pentest, opt-in) | Autonomous AI code review of `local-setup` (source mode, no live target). Adds CVSS + CWE + independent validation. Overlaps **enrich** existing findings (CVSS/CWE badge); net-new are added. Manual opt-in only - see the Strix section. |
| **GitHub secret scanning** (native) | Secrets - lower false positives than entropy-based scanners; Checkov secret scanning is intentionally off |

Out of scope here (later phases): `local-setup/k8s/**` (Kubernetes/Tilt) and
`devops/**` (Helm charts + Terraform).

## Trigger

**Manual only.** Actions -> "Security Scan - Ansible Remote Server Deployment" ->
**Run workflow** -> pick the branch from the dropdown. (The button appears once the
workflow is on the default branch.)

## Where results go

- **Public dashboard (primary):** `https://egov-global.github.io/CMS-MOZAMBIQUE/security_scan`
  - report switcher (any past run), risk summary + severity donut, trend across runs
  - findings grouped by rule with **why / how-to-fix**, every location **linked to the exact line** on the scanned commit
  - AI additions (when enabled): executive summary, priority actions, triage badges, dual-pass verify markers, and a "hide likely false positives" toggle
  - timestamps render in the **viewer's local timezone**
- **Security -> Code scanning:** SARIF from both tools + inline PR annotations (engineer triage)
- **Actions run:** a condensed severity summary + the `security-report-data` artifact (`run.json`)

One-time to make the dashboard live: **Settings -> Pages -> Deploy from a branch ->
`gh-pages` / root**. The repo is public, so the dashboard is public by design.

## AI enrichment (optional, free)

An agent pipeline enriches each report when a key is present. Engine is any
OpenAI-compatible LLM; default is **Google Gemini** (model auto-discovered, current-gen
first, with self-heal fallback to a lighter model on deprecation/overload).

1. **context** - reads the real code around each finding and the deployment topology
   (compose services on a private bridge network behind an nginx reverse proxy)
2. **triage** - **deployment-aware**, classifies each finding as **action_required** /
   **acceptable** (real but okay in this context) / **false_positive**, with a
   **priority** (P1/P2/P3) and **exposure** (public/internal/local). Run as a **fail-safe
   dual pass**: a primary assessment plus an independent skeptical audit. A finding is
   only downgraded out of action_required when *both* passes agree - any disagreement
   keeps it action_required, so real hardening gaps are never silently hidden.
3. **remediate** - context-aware why/fix grounded in the actual code, with copy-pasteable config
4. **verify** - **dual-pass critic**: a fix is "verified" only if two independent reviewers agree
5. **summary** - executive summary + prioritized action list over the action-required set

## Audit workbook (Excel)

Each run also produces a multi-sheet **`security-audit.xlsx`** (published as
`security_scan/security-audit-latest.xlsx` and per-run `data/<runId>.xlsx`, and attached
to the Actions run as an artifact). Download it from the dashboard's **Export audit (Excel)**
button. Sheets:

- **Summary** - counts by tracking status, priority, and category
- **Action Required** - the tracking list (only findings that genuinely need fixing), with
  blank Status / Owner / Target date / Notes columns for the team, plus why, fix, reference and location
- **Not Tracked** - acceptable and false-positive findings with the reason they are excluded
- **All Locations** - every occurrence of an action-required finding (file:line + deep link)

**Enable:** add a repo secret **`GEMINI_API_KEY`** (free key from
[aistudio.google.com](https://aistudio.google.com); a personal Google account works
if your org blocks AI Studio). The model is **auto-discovered** from the key and
ranked by reasoning capability (prefers the thinking model `gemini-2.5-flash`, then
`gemini-2.5-pro`, then older fallbacks) - so it never pins a model the key can't serve.
Pin one explicitly with the optional repo variable `GEMINI_MODEL`. To use a different
provider, set `LLM_BASE` + the key and model.

**Guardrails:** no key = clean no-op (curated remediation kept); raw scanner findings
are never altered (agents only annotate); likely false positives are **labelled, never
dropped**; per-rule results are cached on `gh-pages` so unchanged rules aren't re-run.
Any failure falls back to curated text - it never breaks the pipeline.

## Strix AI pentest (opt-in, manual)

An autonomous AI security agent ([usestrix/strix](https://github.com/usestrix/strix)) does a
**deep source-mode code review** of `local-setup` (no live target, no exploitation). It adds
**CVSS scores, CWE IDs, and independent validation** on top of the static scanners. When a Strix
finding overlaps one of ours, it **enriches** that finding with a `Strix · CVSS · CWE` badge
instead of duplicating; net-new Strix findings are added as their own rows.

**Cost:** runs on a **ChatGPT Plus/Pro subscription** (`chatgpt/gpt-5.4`) via the `STRIX_AUTH`
secret - **no metered API charge**. It is token-heavy (deep scans make hundreds of calls and can
briefly hit the plan's rate cap), so it is **manual opt-in only**, intended for an occasional
(e.g. weekly) run - never per-push. Each run is **fresh** (no cache).

**Enable:**
1. Log in once locally: `strix auth login chatgpt` (browser OAuth).
2. Store the credential as a repo secret: `base64 -i ~/.strix/subscription-auth.json` -> secret
   **`STRIX_AUTH`**. (It contains a refresh token, so CI keeps working without re-login.)
3. Run the workflow with the **`run_strix`** input checked. The step restores the credential,
   runs `strix -n -t ./local-setup -m deep --scope-mode full`, and merges the SARIF.

**Authorization:** source-mode only touches code in this repo - no system is attacked. (Strix's
live/dynamic modes are deliberately not used here.)

## Reading the report

- **Count** = how many times a rule matched, grouped into one issue type.
- **Severity** = KICS native; Checkov bucketed (Medium); Strix from CVSS; **Info is folded into Low** (4-level scale).
- **Status** (AI) = action required / acceptable / false positive. Only **action required**
  is tracked in the Excel audit; the "Hide non-actionable" toggle focuses the dashboard on it.
- **Priority** (AI) = **P0** (critical / act now) / P1 (high) / P2 (medium) / P3 (defense-in-depth).
- **Strix** (opt-in) = independent AI-pentest validation, shown as a `Strix · CVSS · CWE` badge.
- **Category** = security domain (Container Isolation, Hardening, Network Exposure, TLS, Secrets, Resource Controls, Data Sharing).
- **Verify** (AI) = the fix passed both critics (`verified`) or was flagged (`needs review`).

## Enforcement (currently report-only)

`soft-fail: true` (Checkov) and `fail_on: ""` (KICS) report without failing. To enforce
after triage: set `soft-fail: false` + KICS `fail_on: high`, then add the check as
required in branch protection.

## Files

| File | Role |
|------|------|
| `.github/workflows/security-scan.yml` | the pipeline |
| `.checkov.yaml` | Checkov scope (Ansible) |
| `.github/scripts/custom_rules.py` | setup-specific security rules (CMS-SEC-*), grounded in the live-VM audit |
| `.github/scripts/ansible_lint_to_findings.py` | convert the ansible-lint dry-run SARIF into security findings |
| `.github/scripts/strix_to_findings.py` | convert the Strix pentest SARIF into findings (CVSS/CWE), dedup vs existing |
| `.github/scripts/security_report.py` | merge scanners -> `run.json` (+ curated remediation, categories) |
| `.github/scripts/enrich_report.py` | Gemini agent pipeline: deployment-aware triage, remediate, verify (optional) |
| `.github/scripts/build_audit_xlsx.py` | build the multi-sheet Excel audit workbook |
| `.github/scripts/build_manifest.py` | index runs for the switcher/trend |
| `.github/scripts/publish_pages.sh` | publish to `gh-pages` (keeps history) |
| `.github/security-dashboard/index.html` | the dashboard |
