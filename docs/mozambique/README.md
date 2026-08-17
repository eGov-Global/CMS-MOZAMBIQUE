# CMS Mozambique — Release Documentation

**Release:** `cms-mozambique-v1.0.0` (annotated git tag — not a plain `v1.0.0`)
**Release commit:** `124678e55b6f59aeba61bae753e6b00ef842dfb7` on `master` ("Create stateige.yml.example (#3)", 2026-08-14)
**Repository:** `eGov-Global/CMS-MOZAMBIQUE` — DIGIT Complaint Management System, Mozambique deployment line
**Nature of the release:** documentation only. This release changes **no application code**.

---

## Read this first: what this repository actually is

`CMS-MOZAMBIQUE` is a **mirror of the Mozambique product line that is developed inside the upstream repository**, not an independently maintained fork.

- Upstream repo: `egovernments/Citizen-Complaint-Resolution-System`, branch `release-v2.12-moz`.
- **552 of the 556** Mozambique commits were authored, reviewed and merged *in the upstream repository*. This repo mirrors them; do not attribute them to the fork.
- The fork's own delta over the upstream baseline is **4 commits, 2 files, +293 lines**: `.github/CODEOWNERS` and `local-setup/ansible/inventory/host_vars/stateige.yml.example`.

So there are three different — and all true — ways to size "the Mozambique delta". Keep them distinct; mixing them is the most common mistake newcomers make. See [UPSTREAM-BASELINE.md](UPSTREAM-BASELINE.md).

| Question | Comparison | Size |
|---|---|---|
| What does the fork add on top of its upstream baseline? | `343617ce..124678e5` | 4 commits · 2 files · +293 |
| What does Mozambique customize vs. the upstream product master? | `815b2374..124678e5` | 556 commits · 256 files · +31,277 / −2,288 |
| What upstream Mozambique work is *not* in this release? | `124678e5..b55c8533` | 9 commits (see below) |

**Upstream baseline in one line:** this release is built on upstream `343617ceab56b28ced9ad276286d9afc0ef613a8` (`release-v2.12-moz`, "Merge pull request #1757", 2026-08-14); upstream `master` is fully contained at `815b23747a6064736a5449cd2ecf7aae81b0c567`.

The fork is **4 ahead / 9 behind** the current upstream tip `b55c8533`. It has diverged: a fast-forward resync is not possible, and `reset --hard` would destroy the two fork-only files. Resyncing is a separate post-v1.0.0 activity.

---

## Document index

All files below sit in the same directory as this README.

| Document | What it answers | Read it when |
|---|---|---|
| [RELEASE-NOTES.md](RELEASE-NOTES.md) | What ships in `cms-mozambique-v1.0.0`, what does **not**, and the known limitations | You are approving, announcing or accepting the release |
| [CHANGELOG.md](CHANGELOG.md) | Change history for this release line, grouped by area | You need "what changed, in order" |
| [UPSTREAM-BASELINE.md](UPSTREAM-BASELINE.md) | Exact baseline SHAs, divergence proof, the 9 excluded upstream commits, why no resync | You need provenance, or you are planning the upstream resync |
| [CONFIGURATION.md](CONFIGURATION.md) | Configuration surface: MDMS/seed data, tenants, roles, localization, and the post-deployment steps an operator must perform | You are standing up or tuning an environment |
| [DEPLOYMENT.md](DEPLOYMENT.md) | How this stack is deployed (Ansible → single-host Docker Compose, Kong, Gatus), migrations, rollback posture | You are deploying, upgrading or rolling back |
| [MOZAMBIQUE-CUSTOMIZATION-MATRIX.md](MOZAMBIQUE-CUSTOMIZATION-MATRIX.md) | The 118 classified in-release customizations (74 production-critical), by area, with file paths | You are asking "did Mozambique change X?" |
| [release-manifest.yml](release-manifest.yml) | Machine-readable release identity: tag, commit, baseline, artifacts, excluded commits | You are automating verification or wiring CI/CD |

---

## How to answer "what did Mozambique customize?"

Answer in this order — the two documents are complementary, not interchangeable.

1. **Start with [MOZAMBIQUE-CUSTOMIZATION-MATRIX.md](MOZAMBIQUE-CUSTOMIZATION-MATRIX.md).** It is the feature-level answer: 118 classified customizations across 256 changed files, each mapped to an area and to concrete paths, with 74 flagged production-critical. Use it to decide *whether* an area is customized and *where* to look in the tree.
2. **Confirm scope with [UPSTREAM-BASELINE.md](UPSTREAM-BASELINE.md).** It defines which comparison the matrix is measured against (`815b2374..124678e5`, the product-customization view) and records what is deliberately excluded.
3. **Reproduce it yourself** if you need byte-level certainty:
   ```
   git diff --stat 815b23747a6064736a5449cd2ecf7aae81b0c567...124678e55b6f59aeba61bae753e6b00ef842dfb7
   git diff --stat 343617ceab56b28ced9ad276286d9afc0ef613a8   124678e55b6f59aeba61bae753e6b00ef842dfb7
   ```
   The first is the product-customization view; the second is the fork-local delta (2 files, +293).

**Do not use a tag as the baseline.** Upstream tag `v2.12-beta` was force-moved (`8c7c4fe6` → `5f86a102`) and contains **zero** Mozambique-line commits. Compare against the SHAs above only.

**Two things the matrix will tell you, worth knowing up front:**
- **Database:** there are **zero Mozambique-specific database migrations**. All 22 Flyway migrations are byte-identical to upstream (`git diff --name-only 815b2374...master -- '*.sql'` returns nothing). Nothing in this release blocks an image rollback on migration grounds.
- **Tests:** across all 556 commits, **1 test was added and 2 modified**. There is no automated coverage for workflow transitions, notifications, extended attributes, roles/permissions or localization. This is the single largest release-readiness gap.

---

## Before you deploy — flagged items

These are summarized here only so nobody misses them; the authoritative text is in [RELEASE-NOTES.md](RELEASE-NOTES.md).

- **Security, unresolved:** `POST /pgr-services/v2/request/_admin/_search` has **no server-side authorization gate** — no ACCESSCONTROL action, no `@PreAuthorize`, no Kong route entry; the only gate is client-side. Proven on the cms-pilot environment: a user holding only `CMS_SCREENING_OFFICER` + `EMPLOYEE` received HTTP 200 with complaint rows. Not fixed in this documentation-only release.
- **Manual post-deploy step required:** deploy-time CMS seeding is not in this release. `node docs/migration/ccrs-migrate.cjs --only cms` must be run by hand.
- **Roles:** seed files contain 7 `CMS_*` roles; this release's migration registers only 5. `CMS_ADMIN`, `CMS_DASHBOARD_VIEWER` and `CONFIDENTIAL_COMPLAINT_VIEWER` need manual registration even though features that use them are in the release.
- **Operator-owned configuration:** the product seed ships **both** authorities active (IGE and IGSAE). An IGE-only launch is achieved by the operator narrowing the environment after deployment. See [CONFIGURATION.md](CONFIGURATION.md).
- **Not in this release:** CCSD-1937 (auto-registration of the three extra CMS roles + deploy-time seeding) and CCSD-2171 (analytics `boundaryPath` subtree parameter and dashboard geography drill-down) — 9 upstream commits, enumerated in [UPSTREAM-BASELINE.md](UPSTREAM-BASELINE.md). Do not describe those features as included.

---

## Orientation for a first-time reader of the code

- **The deployed frontend is `digit-ui-esbuild`** (esbuild, React 17 SPA, served at `/digit-ui`). `digit-ui-v2` and `frontend/micro-ui` are legacy and are **not deployed**. `configurator` (DIGIT Studio) is active for Mozambique.
- **Only ~7 first-party backend services exist in-tree** — `pgr-services`, `digit-config-service`, `novu-bridge`, `novu-bridge-endpoint`, `novu-dashboard`, `digit-user-preferences-service`, `xstate-chatbot`, plus `utilities/default-data-handler`, `utilities/otp-publisher`, `digit-mcp` and `turbopass/search-api`. **Every other DIGIT service is a prebuilt `egovio/*` image with no source here.** Java services are Java 17 / Spring Boot 3.2.2 (`pgr-services` 3.0.0).
- **Deployment is a single host**: `local-setup/ansible/deploy.sh <tenant>` → `playbook-deploy.yml` → `local-setup/docker-compose.egov-digit.yaml` (with migrations, monitoring and fast-path overlays), fronted by Kong, health-checked by Gatus.

---

## Conventions used in this documentation set

- **Traceability:** every factual claim is anchored to a file path or a commit SHA that you can check out and verify.
- **"NOT VERIFIED"** appears wherever a claim could not be confirmed. It means exactly that — treat it as an open question, not as a soft yes.
- **Versioning follows upstream policy** (`docs/rapid-release-approach.md` §4): SemVer `vMAJOR.MINOR.PATCH`; tags are immutable and are the unit of deployment. §6 governs rollback: image rollback is safe only while migrations remain backward-compatible.
- **Credentials:** no secret values appear anywhere in these documents. Any credentials visible in `*.example` files are example/test defaults that **must be changed** before use.