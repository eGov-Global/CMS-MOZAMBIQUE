# Owner setup (one-time) — Apps Script + gh-pages

This is for the **tool owner** (whoever holds the Drive + the GitHub write token). Runners
don't need this — they just use `run.sh` (see README.md).

## 1. GitHub token (write to gh-pages)

Create a **fine-grained PAT**: GitHub → Settings → Developer settings → Fine-grained tokens →
- Resource owner: `eGov-Global`
- Repository access: the CMS repos you'll publish to (e.g. `CMS-MOZAMBIQUE`, `CMS-KENYA`)
- Permissions: **Contents → Read and write**
Copy the token.

## 2. Enable GitHub Pages (per repo)

Repo → Settings → Pages → Source = **Deploy from a branch**, Branch = **gh-pages** `/ (root)`.
(The dashboard serves from `gh-pages:/security_scan/`.)

## 3. Deploy the Apps Script

1. https://script.google.com → New project → paste **`apps-script.gs`** (in this folder).
2. Project Settings → **Script properties** → add:
   - `SHARED_TOKEN` = a long random string (this is what runners set as `SECSCAN_TOKEN`)
   - `GH_TOKEN` = the fine-grained PAT from step 1
3. **Deploy → New deployment → Web app**: Execute as **Me**, Who has access **Anyone** → Deploy,
   and **Authorize** (grant Drive + external requests).
4. Copy the `/exec` URL and paste it into `scan.py` → `WEBAPP_URL` (it's public/safe to commit).

## 4. Give runners the token

Share `SHARED_TOKEN` out-of-band (Slack/password manager). Each runner does
`export SECSCAN_TOKEN='<that value>'` before running. **Never commit it.**

## 5. First run

- If the repo's `gh-pages:/security_scan/` already has an old (CI-pipeline) dashboard, clear
  `security_scan/manifest.json` and `security_scan/data/` once so the Claude runs start clean.
  (The Apps Script seeds a fresh `index.html` from this repo's `security-scan/dashboard-index.html`.)
- Run a scan from any branch and confirm it appears at
  `https://egov-global.github.io/CMS-MOZAMBIQUE/security_scan/`.

## Notes

- The Apps Script **creates/updates only** under `security_scan/` — it never deletes.
- Concurrent runs updating `manifest.json` retry on GitHub 409 conflicts.
- To pin the runner command to an immutable version later, cut a tag (e.g. `security-scan-v1`)
  and change `README.md`'s URL + `run.sh`'s `REF` (or `SECSCAN_REF=<tag>`).
