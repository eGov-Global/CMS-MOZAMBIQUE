# Release Notes — cms-mozambique-v1.0.0

**Product:** DIGIT Complaint Management System — Mozambique
**Repository:** `eGov-Global/CMS-MOZAMBIQUE`
**Release tag:** `cms-mozambique-v1.0.0` — annotated tag created on `124678e5` as part of this release (*not* a plain `v1.0.0`). Before the tag is cut, deploy from the commit SHA.
**Release commit:** `124678e55b6f59aeba61bae753e6b00ef842dfb7` (branch `master`, "Create stateige.yml.example (#3)", 2026-08-14)
**Release date:** 2026-08-14

---

## Overview

`cms-mozambique-v1.0.0` is the **first tagged release of the Mozambique CMS product line**. It marks a known-good, pilot-verified point in the Mozambique code line and gives operators a single immutable reference to deploy, audit and roll back against.

This is a **documentation release**: the tag itself introduces **no application code changes**. Everything it names as "included" is code that was already developed, reviewed and merged upstream on the branch `release-v2.12-moz` between 2026-06-12 and 2026-08-14; this release freezes that state, describes it, and records what is *not* in it.

Two things follow from that, and both matter operationally:

1. There is **nothing to migrate at the database level** — see [Database Changes](#database-changes).
2. The known limitations below — in particular the **unauthenticated admin-search endpoint** in [Security Notes](#security-notes) — are **present in this release and not fixed by it**. They are documented, not resolved.

If you have never seen this repository before, read [What's Included](#whats-included) for the component inventory before attempting a deployment.

| Fact | Value |
|---|---|
| Release version | `cms-mozambique-v1.0.0` |
| Release commit | `124678e55b6f59aeba61bae753e6b00ef842dfb7` |
| Code changes made by the release itself | none (documentation release) |
| Database migrations in this release | **0** |
| Mozambique customizations classified | 118 (74 production-critical) |
| Automated tests added across the whole delta | 1 added, 2 modified |

---

## Based On

### Upstream

| Item | Value |
|---|---|
| Upstream repository | `egovernments/Citizen-Complaint-Resolution-System` |
| Upstream baseline commit | `343617ceab56b28ced9ad276286d9afc0ef613a8` (branch `release-v2.12-moz`, "Merge pull request #1757", 2026-08-14) |
| Upstream product master fully contained at | `815b23747a6064736a5449cd2ecf7aae81b0c567` |
| Current upstream `release-v2.12-moz` tip | `b55c8533a7e48d97045742188308ab4da81a97b9` |
| Fork position vs that tip | **4 ahead / 9 behind — diverged** |

Baseline proof (reproducible):

```
git diff --stat 343617ce 124678e5
# 2 files changed, 293 insertions(+), 0 deletions(-)
#   .github/CODEOWNERS                                              +3
#   local-setup/ansible/inventory/host_vars/stateige.yml.example  +290
```

**Do not use an upstream tag as the baseline.** The upstream tag `v2.12-beta` was force-moved (`8c7c4fe6` → `5f86a102`) and contains **zero** commits from the Mozambique line. Commit SHAs are the only reliable anchor here.

### Why the fork is not synced to the upstream tip

The 9 upstream commits landed **after** the fork's last sync. Because the fork also carries 2 fork-only files, the branches have genuinely diverged: a fast-forward is impossible, and `git reset --hard` to the upstream tip would destroy `.github/CODEOWNERS` and `local-setup/ansible/inventory/host_vars/stateige.yml.example`. This release therefore ships the **analyzed, pilot-verified code as-is**. Resyncing with upstream is a separate, planned post-v1.0.0 activity.

### The 9 upstream commits deliberately NOT in this release

| Commits | Work item | What it is |
|---|---|---|
| `6c19c0c1`, `3ea00efc`, `6e9f1fe5`, `a697917d` | **CCSD-1937** | Registers `CMS_ADMIN`, `CMS_DASHBOARD_VIEWER` and `CONFIDENTIAL_COMPLAINT_VIEWER` in `ccrs-migrate --cms`, and adds deploy-time CMS seeding to the Ansible playbook |
| `1dfc82cd`, `45ee087a`, `943c42de`, `1f082e60`, `b55c8533` | **CCSD-2171** | Analytics `boundaryPath` subtree parameter and the dashboard geography drill-down filter |

**Neither feature is available in `cms-mozambique-v1.0.0`.** Their absence has direct operational consequences — see [Known Limitations](#known-limitations) items 2 and 3 (CCSD-1937) and item 4 (CCSD-2171).

### Mozambique repository

| Item | Value |
|---|---|
| Repository | `eGov-Global/CMS-MOZAMBIQUE` |
| Release | `cms-mozambique-v1.0.0` |
| Release commit | `124678e55b6f59aeba61bae753e6b00ef842dfb7` (branch `master`) |
| Fork-local delta over baseline | 4 commits, 2 files, +293 / -0 |

---

## What's Included

Three distinct measurements describe this release. They are **not** interchangeable — quoting the wrong one misrepresents who built what.

**1. Fork-local delta — `343617ce..124678e5`**
4 commits, 2 files, **+293 lines**:
* `.github/CODEOWNERS` (+3)
* `local-setup/ansible/inventory/host_vars/stateige.yml.example` (+290)

This is the entire code footprint added by the fork.

**2. Mozambique product customization vs upstream product master — `815b2374..124678e5`**
**556 commits, 256 files, +31,277 / -2,288 lines**, spanning 2026-06-12 → 2026-08-14 (Jun 31, Jul 454, Aug 71 commits). This is the body of work the release *packages*.

**3. Attribution**
**552 of those 556 commits were authored, reviewed and merged inside the upstream repository** on branch `release-v2.12-moz`. The fork **mirrors** them; it did not originate them. Only the 4 commits in measurement 1 are fork-work.

From the 556-commit delta, **118 discrete customizations** were classified, of which **74 are production-critical**.

### Component inventory (what actually runs)

Useful if this repository is new to you — most of the DIGIT platform is *not* in this tree.

* **First-party backend services in-tree (~7):** `pgr-services` (the complaint service — Java 17, Spring Boot 3.2.2, artifact version 3.0.0), `digit-config-service`, `novu-bridge`, `novu-bridge-endpoint`, `novu-dashboard`, `digit-user-preferences-service`, `xstate-chatbot`; plus `utilities/default-data-handler`, `utilities/otp-publisher`, `digit-mcp`, `turbopass/search-api`.
* **Everything else** (`egov-user`, `egov-workflow-v2`, `egov-localization`, `mdms-v2`, `egov-idgen`, `egov-hrms`, `egov-persister`, `egov-filestore`, `egov-indexer`, `egov-accesscontrol`, `boundary-service`, …) is consumed as **prebuilt `egovio/*` images with no source in this tree**. You cannot patch them from here.
* **The product frontend is `digit-ui-esbuild`** — an esbuild React 17 SPA served at `/digit-ui`. `digit-ui-v2` and `frontend/micro-ui` are **legacy and not deployed**. `configurator` (DIGIT Studio) **is** active for Mozambique.
* **Deployment:** single-host **Docker Compose driven by Ansible** — `local-setup/ansible/deploy.sh <tenant>` → `playbook-deploy.yml` → `local-setup/docker-compose.egov-digit.yaml` (+ migrations, monitoring and fast-path overlays). Kong gateway; Gatus health checks.

---

## Mozambique-Specific Features

The capabilities below distinguish the Mozambique line from upstream CCRS master (`815b2374`). All are present at the release commit.

### Complaint intake and citizen experience
* **Citizen authority dispatcher with per-category dynamic fields** — the citizen picks (or is auto-routed to) an oversight authority, and the form renders category-specific fields captured into `extendedAttributes`.
* **Restructured 3-step citizen create wizard** with a full validation sweep, and **draft persistence** for both the citizen wizard and the employee create form (tenant/user-stamped, cleared on submit).
* **Employee create-complaint**: channel of receipt, complainant address, map pin, dynamic fields.
* **Public, config-driven landing page** ("Fala Cidadão" / IGE) plus an in-app **Privacy Policy** served from `commonMDMSConfig` for three UI modules.
* **Single-module citizen navigation** — "All Services" removed, sidebar entries repointed to the PGR home.
* **Citizen complaint details rebuilt on the workflow timeline**, with leaf-type titles, full status pills and per-complaint tenant resolution in the list.
* **Rate & Close screen redesign** using the Mozambique feedback option set; **citizen reopen flow overhaul** preserving routing data via an `additionalDetail` merge.
* **Attachments**: one shared upload component wired into every PGR surface, per-step timeline attachments, and video/audio playback with shared attachment classification.

### CMS multi-tier workflow and roles
* **CMS multi-tier PGR workflow BusinessService** (`utilities/default-data-handler/src/main/resources/CmsPgrWorkflowConfig.json`) with reception → screening → supervision → case-management tiers.
* **Fully workflow-driven employee action modal** — available actions come from the workflow engine rather than a hardcoded table.
* **History-derived assignee routing** for reopen / rate / route-back actions, including **CCSD-2167**: accepting an assignee on *terminal* transitions without breaking `egov-workflow-v2`.
* **Role taxonomy expansion**: `ACCESSCONTROL-ROLES` grows 22 → 35 codes (+13) and `ACCESSCONTROL-ROLEACTIONS` grows 396 → 731 rows (**+335 grants, 0 removed**).
* **Auto-escalation removed** from the CMS workflow; **citizen participation narrowed** (COMMENT dropped from open states — staff records the citizen's answer instead).

### Access control and confidentiality
* **Employee department-scoped complaint search** — opt-in, fail-closed ABAC on `_search` / `_count` / `plainSearch`.
* **Confidential complaints** with selective field visibility (MDMS `x-no-mask` + `allowedViewerRoles`) and a plaintext-safe masking overload; a Complainant Details card on the employee details page.
* **Cross-department Admin Complaint Search** page and endpoint — ⚠️ **read [Security Notes](#security-notes) before enabling this in production.**
* **`writeRoles` UX gate** on generic MDMS create/edit in the configurator (Encryption Policy restricted to `MDMS_ADMIN` / `SUPERUSER`).

### Notifications
* **3-tier department resolution fallback** with null-safety and no-throw degradation.
* **Newest-matching process instance** selected for notification context (previously the oldest).
* **New `assigner_*` placeholders** — department, name and designation of the acting employee.

### Master data, localization and migration tooling
* **`docs/migration/ccrs-migrate.cjs`** — the unified, idempotent migration runner. Nine phases: `auth, schemas, hierarchy, pgr-masters, landing, cms, banner, gzip, verify`; continue-on-error; **never overwrites** existing localization or master rows (add-if-missing; masters drift is reported, `--update-masters` is opt-in).
* **PGR dynamic-fields master-data model** — `ComplaintRelatedToMap`, `ComplaintTemplateType`, `ComplaintExtendedAttributeSchema` (schemas + seeds under `docs/migration/seed/`).
* **Portuguese (`pt_PT`) localization packs** and locale registration, plus the **"Fala Cidadão" rebrand** and an expanded `en_IN`/default pack; CMS workflow state and action localization seeds in both locales.
* **Localization infrastructure**: city-tenant overlay (state + city merge, city wins), default-locale bootstrap, double-resolve fixes.
* **MDMS v2 tenant scoping + IndexedDB persistence** for master data on the frontend.

### Configurator (DIGIT Studio)
* **Visual Landing Page Builder** — a 3-pane WYSIWYG studio over the MDMS landing masters, with staged human-readable localization edits, per-locale upsert, cache-bust and instant preview.
* **Landing masters as first-class MDMS resources** (generic CRUD + sidebar group); previously-blank Edit forms fixed for UI Homepage / Security Policy / Encryption Policy.
* **Role-Actions creatable and editable from the UI**; master registry corrections (StateInfo → "Branding", Decryption ABAC identifier).
* **Builder media library** over the platform filestore; full-canvas workspace; return-to-home affordances.
* Configurator now **boots in the environment's default locale** via the shared `globalConfigs` mechanism.

### Dashboard
* **Embedded dashboard breadcrumb and gutter/vertical-rhythm restoration.**
  *Note:* the **CCSD-2171 geography drill-down is not part of this release.*

---


### Notifications — routing and resolution (Mozambique changes on upstream infrastructure)

**Attribution first, because it is easy to get wrong:** the notification *infrastructure* is **upstream CCRS**, not Mozambique work. `novu-bridge`, `novu-bridge-endpoint`, `novu-dashboard` and `xstate-chatbot` (WhatsApp) all exist in upstream `master` (`815b2374`) and are unchanged by this release. Email/SMS/WhatsApp delivery via Novu is an upstream v2.12 capability.

**What Mozambique customized** is the routing and resolution layer inside `pgr-services` — a single file, and the **largest single backend change in the delta**:

| File | Change |
|---|---|
| `backend/pgr-services/src/main/java/org/egov/pgr/service/NotificationService.java` | **+129 / −33** (162 lines changed) |

Contents of that change:

* **Three-tier department resolution for notification content** (`resolveComplaintHierarchyDepartment`, `readAdditionalDetailsDepartment`): the department shown in a notification resolves in priority order — ComplaintHierarchy mapping for the `serviceCode`, then the complaint's stored `additionalDetails.department`, then the assignee's current HRMS department. Previously an unmapped `serviceCode` raised `JSONPATH_ERROR` / `PARSING_ERROR` and the notification failed; resolution is now null-safe and degrades instead of throwing.
* **New `assigner_*` placeholders** (`putAssignerPlaceholders`) — department, name and designation of the acting employee, resolved through the HRMS designation JSONPath, so templates can address who performed the action rather than only who receives it.
* **Newest-instance assignee resolution (CCSD-2167)** — `getEmployeeName` previously returned the **last** matching element of the workflow-history response, but history is newest-first, so it returned the **oldest** ASSIGN and `{emp_name}` named the wrong employee. It now selects the newest matching transition by `lastModifiedTime`.

Key commits: `4fa8964c` (department display logic), `f05c52d5` (CCSD-2167 newest-instance resolution).

**Configuration:** notification routing and templates are MDMS-driven (`RAINMAKER-PGR.NotificationRouting`, `RAINMAKER-PGR.NotificationTemplate`) and are configurable without code changes — see `CONFIGURATION.md`. A missing template for an (audience, action, state, channel, locale) combination results in a silent skip, so template coverage must be verified per environment.

## Changes

Behavioural and infrastructure changes relative to upstream product master `815b2374`.

| Area | Change |
|---|---|
| API | **New endpoint** `POST /pgr-services/v2/request/_admin/_search` (cross-department admin search). See [Security Notes](#security-notes). |
| API | `department` query parameter added to the existing `_search` / `_count` contract; `createdBy` filter added (reception-officer "complaints I filed" inbox, CCSD-2135). |
| API | `lastModifiedTime` sort option added to the shared search query builder. |
| API | Channel-of-receipt codes accepted as `service.source` (`allowed.source` extension). |
| Locale | Container-mode `digit-ui` boot config defaults to **`pt_PT` / PT**. |
| Filestore | `ALLOWED_FORMATS_MAP` extended with video, audio-capable containers and `pptx`. |
| Infra | Postgres base image moved off the preview registry to `egovio/postgres:16`. |
| Infra | **`default-data-handler` removed from the Compose stack** (see Known Limitation 7). |
| Infra | gzip + `Cache-Control: no-cache`, scoped to the `/digit-ui` static location in all three nginx render paths. |
| Infra | `local-setup/scripts/deploy-pilot-fe.sh` — one-shot Mozambique pilot/prod frontend build + deploy. |
| Infra | Password-gated `/digit-ui-test` testing entrance, rendered by the playbook, **default OFF**; scoped by the configurator `isTestingTenant` flag. |
| Unchanged | **No Mozambique changes** to CI (`.github/` workflows), Helm/deploy-as-code charts (`devops/`), the top-level `ansible/` tree, or the root `docker-compose.egov-digit.yaml`. |

---

## Bug Fixes

Defect-class items included in the release (all relative to upstream master `815b2374`):

* **Native `pattern` attribute crash** — a compiled `RegExp` was being serialized into the DOM; fixed.
* **Citizen profile validation and options** — Portuguese name characters, email and gender handling.
* **Notification department resolution** — null-safety and no-throw degradation, so a missing department no longer fails the notification path.
* **Notification process-instance selection** — resolves the newest matching instance instead of the oldest (CCSD-2167 part 2).
* **Map fixes** — tenant-scoped `MapConfig` / ward tree, reverse-geocode loop guard, tooltip and toast corrections.
* **Boundary cascade** — jurisdiction gate disabled where inappropriate, childless-leaf rendering fixed, lazy tenant-scoped initialisation.
* **Localization propagation** — edits now surface immediately (3-cache invalidation on save, correct default module).
* **`tenant.citymodule` / `bannerImage`** — schema property added, banner seeding phase, and `docs/migration/fix-citymodule.sh` to repair on-box schema drift for rows created before the field existed.
* **`INFOFROMCITIZEN` `docUploadRequired`** flipped to `false` (CCSD-2081).

---

## Database Changes

### **NONE.**

This release contains **zero Mozambique-specific database migrations**. Verified:

```
git diff --name-only 815b2374...master -- '*.sql'
# (no output)
```

All **22 Flyway migrations are byte-identical to upstream**. No migration is added, altered or reordered anywhere in the 556-commit delta.

**What this means for you:**

* **Fresh install:** no Moz-specific migration to run — standard upstream Flyway init containers do everything.
* **Upgrade:** no schema change, so no schema-compatibility window to manage.
* **Rollback:** **nothing at the database layer blocks an image rollback.** Re-pin the previous image tags and redeploy; the schema is unchanged in either direction. Per `docs/rapid-release-approach.md` §6, image rollback is safe precisely because there is no destructive migration in this release.

**Related gaps you should know about (these are pre-existing, not introduced here):**

1. **There are no down-migrations or undo scripts anywhere in the repository.** If a *future* release does change the schema, the only rollback path is restoring the database from a dump. Take the dump before every deploy.
2. **The MDMS seeding layer has no version table, checksum or applied-state record.** Seeding idempotency is enforced by the runner's logic (add-if-missing), not by recorded state — you cannot query "what has been applied here".
3. **A newly-created workflow BusinessService requires an `egov-workflow-v2` restart** — that service caches BusinessServices at startup. This applies whenever the CMS workflow is seeded into a tenant for the first time.
4. **Two of the inherited migrations end with a non-concurrent `REFRESH MATERIALIZED VIEW`.** Their duration against production-sized data has **not been measured** (NOT VERIFIED). They will take a table lock for that duration. This is inert for *this* release (no migrations run), but relevant to any fresh install.

---

## Configuration Changes

### Product configuration (ships in the repository)

* **PGR dynamic-fields masters** — `docs/migration/seed/ComplaintRelatedToMap.json`, `ComplaintTemplateType.json`, `ComplaintExtendedAttributeSchema.json`, plus their MDMS schema definitions.
* **Landing masters** — `RAINMAKER-PGR.LandingSection` and `RAINMAKER-PGR.LandingPageConfig` under `utilities/default-data-handler/src/main/resources/mdmsData/RAINMAKER-PGR/`.
* **Access control** — `ACCESSCONTROL-ROLES.roles.json` (35 codes) and `ACCESSCONTROL-ROLEACTIONS.roleactions.json` (731 rows).
* **CMS workflow** — `utilities/default-data-handler/src/main/resources/CmsPgrWorkflowConfig.json`.
* **Localization** — `utilities/default-data-handler/src/main/resources/localisations/en_IN/rainmaker-pgr.json` and `utilities/default-data-handler/src/main/resources/localisations/pt_PT/rainmaker-pgr.json`.
* **Privacy policy** content relocated from `commonUiConfig` to `commonMDMSConfig`, seeded for 3 UI modules.
* **`tenant.citymodule`** schema accepts `bannerImage`.

### Post-deployment configuration — authority selection (**read this**)

This is product-vs-environment configuration and it is a common source of confusion.

* **The product seed `docs/migration/seed/ComplaintRelatedToMap.json` ships BOTH authorities active:**

  ```json
  [ { "code": "IGE",   "tenantCode": "mz.ige",   "tenantId": "mz", "active": true },
    { "code": "IGSAE", "tenantCode": "mz.igsae", "tenantId": "mz", "active": true } ]
  ```

* **For an IGE-only launch, the operator narrows the *environment* after deployment** so exactly **one** row is active. The citizen flow then auto-selects that authority and hides the authority picker. This is an environment edit, not a code change — do not modify the seed file to achieve it.

* **Live `cms-pilot` state (verified):** exactly **1 row — `IGE`, `tenantCode = mz`, `active = true`.**

* ⚠️ **The pilot maps `IGE → mz` while the product seed maps `IGE → mz.ige`. Which of the two is intended is NOT VERIFIED.** Both are recorded here deliberately. Do not silently "correct" either one — confirm the intended tenant mapping with the product owner before changing an environment, because the mapping determines which tenant complaints are created against.

### Environment / inventory configuration

* **`local-setup/ansible/inventory/host_vars/stateige.yml.example`** (new in this release, +290 lines) — the Mozambique starting point for a new host's `host_vars`. ⚠️ It still carries the header of `bomet.yml.example` (referring to `deploy.sh bomet`) and sets `domain: localhost`. **The header is stale and misleading; edit both before use.**
* Any credentials appearing in example inventory files are **example/test defaults that MUST be changed** before any non-local deployment.
* Testing entrance keys (all default OFF): `testing_ui_enabled`, `testing_tenant`, `testing_ui_htpasswd`, `testing_ui_path` (default `digit-ui-test`), `testing_ui_banner`.

---

## Deployment Changes

The deployment model is **unchanged from upstream**: `./deploy.sh <tenant>` from an operator controller, one idempotent Ansible pass against a single VM running the Docker Compose stack behind Kong, with Gatus health checks. **There is no CD pipeline** — GitHub Actions builds and publishes `egovio/*` images; pinning an image on a host is a manual `host_vars` edit followed by an operator-run deploy.

Mozambique-specific deployment content in this release:

* **`docs/migration/ccrs-migrate.cjs`** — the single migration/seeding entry point (9 phases; see [Mozambique-Specific Features](#mozambique-specific-features)).
* **`docs/migration/enable-gzip.sh`** and the runner's `gzip` phase — guided enablement of gzip + `Cache-Control` for `/digit-ui`.
* **`docs/migration/fix-citymodule.sh`** — on-box MDMS schema-drift repair.
* **`local-setup/scripts/deploy-pilot-fe.sh`** — frontend-only refresh between releases.
* **Operator documentation set**: `docs/migration/operator-runbook.md`, `docs/migration/README.md`, `docs/migration/seed/pgr-dynamic-fields-masters-onboarding.md`, `docs/migration/tenant-department-migration-guide.md`, `docs/ops/digit-ui-compression.md`.

**Not in this release — plan around these:**

* ❌ **Deploy-time CMS seeding is absent.** `playbook-deploy.yml` at `124678e5` contains **no** CMS seed task (verified: zero matches for `cms` in that file). Running `node docs/migration/ccrs-migrate.cjs --only cms` is a **mandatory manual post-deploy step**.
* ❌ **The `nginx` Ansible tag does not exist** at this commit (zero `tags: ['nginx']` markers in `playbook-deploy.yml`), yet `docs/ops/digit-ui-compression.md:55` documents `./deploy.sh <host> --tags nginx`. **That documented surgical command is a silent no-op** — it will report success while changing nothing. Use `docs/migration/enable-gzip.sh` or a full deploy instead.

---

## Breaking Changes

**None are introduced by this release.** `cms-mozambique-v1.0.0` changes no **application code**, schema, API contract or configuration format relative to its baseline `343617ce`. The two files added over the baseline (`.github/CODEOWNERS`, `local-setup/ansible/inventory/host_vars/stateige.yml.example`) are repository governance and an inventory template, not runtime code.

If you are moving an environment **from stock upstream CCRS to the Mozambique line**, the following are *behaviour differences*, not regressions within the Moz line — plan for them:

* **Role catalogue expands** 22 → 35 codes with +335 grants. Users must be re-assigned to CMS roles; **users must re-login** after a role change for it to take effect.
* **CMS multi-tier workflow replaces the standard PGR workflow** for CMS tenants. Auto-escalation is removed and `COMMENT` is no longer available to citizens in open states.
* **`default-data-handler` is no longer in the Compose stack** — anything that relied on it running at deploy time must be replaced by the migration runner.
* **Citizen navigation is single-module** — the "All Services" screen is gone and sidebar entries point at the PGR home.
* **Employee complaint search can be department-scoped** (opt-in, fail-closed). Enabling it narrows what existing employees can see.

---

## Upgrade Instructions

For an environment **already on the Mozambique line** (e.g. the `cms-pilot` box) moving to `cms-mozambique-v1.0.0`.

1. **Back up the database. This is the only rollback insurance that exists.**
   ```
   docker exec docker-postgres pg_dump -U egov -Fc egov > ~/pre-deploy-$(date +%F).dump
   ```
   Confirm the dump is non-empty before continuing.
2. **Check out the release by tag** — `git fetch --tags && git checkout cms-mozambique-v1.0.0`. Deploy from the tag, never from a moving branch.
3. **Pin the images** for this cut in `local-setup/ansible/inventory/host_vars/<tenant>.yml`: `pgr_services_image`, `digit_ui_image`, `configurator_image`, and any others you build. **No `-db` (Flyway) image tag needs bumping — this release has no migrations.**
4. **Dry run**: `cd local-setup/ansible && ./deploy.sh <tenant> --check --diff` and read every templated file diff.
5. **Deploy**: `./deploy.sh <tenant>`. Follow progress with `tail -f /opt/digit/digit-stack-up.<tenant>.progress`.
6. **Run the CMS seed manually — this is not done by the deploy:**
   ```
   node docs/migration/ccrs-migrate.cjs --only cms
   ```
   This registers **5** roles (`CMS_RECEPTION_OFFICER`, `CMS_SCREENING_OFFICER`, `CMS_SUPERVISOR`, `CMS_CASE_MANAGER`, `CMS_VIEWER`), their grants, and the CMS workflow BusinessService.
7. **Register the 3 remaining roles manually** — `CMS_ADMIN`, `CMS_DASHBOARD_VIEWER` and `CONFIDENTIAL_COMPLAINT_VIEWER` exist in the seed files and are required by features that *are* in this release, but the runner in this release does **not** register them (see Known Limitation 2). Create them via the configurator or a direct `ACCESSCONTROL-ROLE` MDMS write.
8. **Restart `egov-workflow-v2`** if the CMS BusinessService was created for the first time on this tenant — it caches BusinessServices at startup and will not see a new one otherwise.
9. **Narrow the authority rows** for the target launch (see [Configuration Changes](#configuration-changes)) so exactly one `ComplaintRelatedToMap` row is active for an IGE-only launch.
10. **Have affected employees log out and back in** so new roles land in their session.
11. **Run the validation and smoke tests** in the next section.

**Rollback:** re-pin the previous image tags in `host_vars`, re-run `./deploy.sh <tenant>`. **No database restore is required for this release** — there are no schema changes in either direction.

---

## Fresh Installation

Condensed; `README.md` and `docs/migration/operator-runbook.md` are authoritative.

1. **Pre-conditions (manual, once per box):** a Debian/Ubuntu or RHEL-family VM; a DNS A record for `domain` verified with `dig +short`; inbound 80/443 open on both the host and the cloud firewall; key-based root SSH from the controller.
2. **Controller setup:** clone the repository at tag `cms-mozambique-v1.0.0`; install `ansible-playbook` (`deploy.sh` exits 127 without it); `ansible-galaxy collection install -r local-setup/ansible/requirements.yml`.
3. **Write `host_vars/<tenant>.yml`** — start from `local-setup/ansible/inventory/host_vars/stateige.yml.example` (**fix its stale `deploy.sh bomet` header and `domain: localhost`**). Mandatory keys include `ansible_host`, `domain`, `tls_enabled`, `state_root`, `state_tenant_id`, `tenant_id`, `ui_state_tenant_id`, `core_mobile_configs`, `pgr_boundary_highest/lowest_level`, `hierarchy_type`, `login_tenant_allowlist`, `nginx_features`, `secrets_path`, `bootstrap_secrets`. **Replace every example/test credential.** Keep `db_fast_path: true` only on a box with no data worth keeping.
4. **Dry run**: `./deploy.sh <tenant> --check --diff`.
5. **Deploy**: `./deploy.sh <tenant>`. The playbook provisions Docker, syncs configs, renders `.env` / `globalConfigs.js` / nginx, pulls and starts 60 services (plus overlay files) (Flyway migrators run inside that `up`), waits for health, bootstraps the tenant via MCP, rewrites `STATE_LEVEL_TENANT_ID`, builds and publishes the frontends, renders host nginx, then runs its validation gates.
6. **Run the CMS seed** — `node docs/migration/ccrs-migrate.cjs --only cms` — then **restart `egov-workflow-v2`** so it picks up the new BusinessService.
7. **Register `CMS_ADMIN`, `CMS_DASHBOARD_VIEWER`, `CONFIDENTIAL_COMPLAINT_VIEWER` manually** (Known Limitation 2).
8. **Seed the remaining product masters** as needed with the runner's other phases (`schemas`, `hierarchy`, `pgr-masters`, `landing`, `banner`).
9. **TLS (manual, first time only):** `sudo certbot --nginx -d <domain> --agree-tos -m <ops-email> --no-eff-email --redirect`, then `nginx -t`, `curl -sI https://<domain>/`, and confirm `certbot.timer` is scheduled.
10. **Tenant master data (manual, not part of the deploy):** onboard boundaries, departments, designations, complaint types and employees via the configurator wizard, the Jupyter DataLoader, or MCP `city_setup_from_xlsx`. **Skipping this leaves a technically healthy but unusable tenant.**
11. **Narrow the authority rows** for the launch scope, then run the smoke tests below.

---

## Validation / Smoke Tests

### Automatic (run by the playbook; a failure fails the deploy)

No broken containers; 10 core services healthy through Kong; `/digit-ui/` returns 200; `/configurator/` returns 200; `/status/` returns 200; `/mcp` returns 405; an ADMIN token is minted; MDMS `StateInfo` is non-empty; OpenBao is unsealed. The run ends with a printed **INFRA VALIDATION RESULTS** summary.

### Manual (required in production, where CI tests are disabled)

```
newman run local-setup/postman/digit-core-validation.postman_collection.json \
  --env-var baseUrl=https://<domain>

newman run local-setup/postman/complaints-demo.postman_collection.json \
  --env-var url=https://<domain> --env-var username=<user> \
  --env-var stateTenant=mz --env-var cityTenant=mz.<city> --delay-request 2000
```

Then eyeball Gatus at `/status/` and perform a real end-to-end pass:

1. Citizen login → create a complaint through the 3-step wizard → confirm the authority picker behaves as configured (hidden when exactly one row is active).
2. Employee login → inbox → assign → act through the CMS workflow tiers → resolve.
3. Citizen reopen and rate-and-close, confirming assignee routing.
4. Confirm `pt_PT` strings render (no raw localization keys) on both citizen and employee shells.
5. Confirm attachments upload, and that video/audio play back.
6. Confirm a confidential complaint masks fields for a user without `CONFIDENTIAL_COMPLAINT_VIEWER`.

### ⚠️ Test coverage reality

**Across all 556 commits, exactly 1 test was added and 2 were modified:**

* added — `configurator/src/providers/resolveInitialLocale.test.ts`
* modified — `backend/.../PGRServiceCountScopingTest.java`, `configurator/.../dataProvider.test.ts`

**There is no automated coverage for workflow transitions, notifications, extended attributes, roles/permissions, or localization.** This is the single largest release-readiness gap in this release. The manual pass above is not optional — it is the only functional verification that exists.

---

## Known Limitations

1. **`POST /pgr-services/v2/request/_admin/_search` has no authorization gate.** Documented in full under [Security Notes](#security-notes). **Not fixed in this release.**
2. **Only 5 of the 8 privileged roles the seed ships (7 `CMS_*` + `CONFIDENTIAL_COMPLAINT_VIEWER`) are auto-registered.** Seed files contain 7 `CMS_*` roles plus `CONFIDENTIAL_COMPLAINT_VIEWER`, but `docs/migration/ccrs-migrate.cjs` in this release registers only `CMS_RECEPTION_OFFICER`, `CMS_SCREENING_OFFICER`, `CMS_SUPERVISOR`, `CMS_CASE_MANAGER`, `CMS_VIEWER` (source: `CMS_ROLES` constant, line 763). **`CMS_ADMIN`, `CMS_DASHBOARD_VIEWER` and `CONFIDENTIAL_COMPLAINT_VIEWER` are not registered, although features requiring them ARE in this release.** Register them manually. (Fixed upstream by CCSD-1937 — not included here.)
3. **Deploy-time CMS seeding is not in this release.** `node docs/migration/ccrs-migrate.cjs --only cms` is a **manual post-deploy step**. Forgetting it produces `Role "CMS_..." not valid` failures during employee onboarding.
4. **The CCSD-2171 geography drill-down is not in this release.** The dashboard cannot filter by boundary subtree; boundary filtering remains exact-match only.
5. **The `develop` branch has diverged from `master`** (2 ahead / 1 behind) **but their trees are identical** — pure history duplication of `stateige.yml.example`. Technical debt, **not a release blocker**.
6. **`stateige.yml.example` carries a stale header** — it still refers to `deploy.sh bomet` and sets `domain: localhost`. Misleading for a new operator; edit before use.
7. **`PGR_WORKFLOW_VARIANT` is no longer set anywhere.** Verified: zero occurrences of `PGR_WORKFLOW_VARIANT` at `124678e5`. The property `pgr.workflow.variant` (default `standard`) is read only by `utilities/default-data-handler/src/main/java/org/egov/handler/service/DataHandlerService.java:64`, and that service was removed from the Compose stack — so the CMS workflow now reaches a tenant **only** through the manual `ccrs-migrate --only cms` step. **The behaviour of any environment still running `default-data-handler` under this configuration is NOT VERIFIED — check it before relying on the variant switch.**
8. **The documented `--tags nginx` surgical deploy is a silent no-op** — `docs/ops/digit-ui-compression.md:55` documents it, but no `nginx` tag exists in `playbook-deploy.yml` at this commit.
9. **44 role→action grants are hardcoded to `tenantId: "pb"`** in `ACCESSCONTROL-ROLEACTIONS.roleactions.json` (a leftover from the upstream sample tenant). Those grants do not apply to `mz*` tenants.
10. **`PENDINGFORREASSIGNMENT` reports `applicationStatus` `REASSIGND`** (see the javadoc at `backend/pgr-services/src/main/java/org/egov/pgr/service/WorkflowService.java:226`). Any consumer filtering on `applicationStatus` must match the abbreviated string, not the state name.
11. **Notification routing and templates were never extended to the CMS workflow states** — CMS-state transitions may not produce notifications.
12. **Documentation drift**: several design documents under `docs/` describe approaches that were superseded or contradicted by what shipped (notably the complaint-search design vs the shipped AdminSearch screen, and an authority→tenant design based on an `AuthorityConfig` master that was never built). Treat code as the source of truth.
13. **No down-migrations, no seeding version table, and unmeasured materialized-view refresh time** — see [Database Changes](#database-changes).

---

## Security Notes

### 🔴 Critical — `POST /pgr-services/v2/request/_admin/_search` has NO authorization gate

**This is stated plainly because it is exploitable and it is NOT fixed in this release.**

**The finding:**

* `backend/pgr-services/src/main/java/org/egov/pgr/web/controllers/AdminComplaintSearchController.java` performs **no role check**. Its javadoc claims the endpoint is gated at the gateway — **that gating does not exist.**
* **No `ACCESSCONTROL` action is registered for the URI** — zero hits in both action masters. There is **no `@PreAuthorize`** annotation and **no Kong route entry** for it.
* `backend/pgr-services/src/main/java/org/egov/pgr/service/AdminComplaintSearchService.java` validates **only `tenantId`**, and sets `skipEmployeeDepartmentScope(true)` — **deliberately bypassing the department ABAC** that protects the normal search path. The two `SUPERUSER` mentions in that file are **comments**, not enforcement.
* **The only gate is client-side**: `ADMIN_SEARCH_ROLES` in `digit-ui-esbuild/products/pgr/src/pages/employee/AdminSearch.js` hides the screen. This is trivially bypassed by calling the API directly.

**Proven, not theoretical:** on the `cms-pilot` environment, a user holding **only `CMS_SCREENING_OFFICER` + `EMPLOYEE`** received **HTTP 200 with complaint rows** from this endpoint.

**Impact:** any authenticated employee — regardless of department, role or scope — can enumerate complaints across all departments in a tenant, defeating department scoping and the confidential-complaint controls.

**Status in this release:** **NOT FIXED.** `cms-mozambique-v1.0.0` is a documentation release and makes no code changes.

**Recommended fix (either is sufficient; the first is stronger):**
1. Enforce the required role inside the service or controller, or
2. Register the `ACCESSCONTROL` action for the URI and add the corresponding `roleactions` grant so the platform's access-control layer gates it.

**Interim mitigation until fixed:** restrict network access to the endpoint at the gateway/nginx layer, and treat the client-side `ADMIN_SEARCH_ROLES` list as **cosmetic only** — do not count it as a control in any risk assessment.

### Other security-relevant notes

* **Unregistered privileged roles.** `CMS_ADMIN`, `CMS_DASHBOARD_VIEWER` and `CONFIDENTIAL_COMPLAINT_VIEWER` are not auto-registered by this release's runner (Known Limitation 2). Do not work around this by loosening grants on other roles — register the intended roles.
* **`CMS_VIEWER` is not read-only.** Despite the name, it carries write authority in the shipped grant set. Do not assign it as a "safe" observer role.
* **Department scoping is opt-in.** Employee department-scoped search is fail-closed once enabled, but it is **off unless configured** — confirm its state per environment.
* **Credentials in example files.** Any credential appearing in `stateige.yml.example` or other example inventory files is an **example/test default that MUST be changed** before any non-local deployment.
* **The testing entrance is default OFF.** `/digit-ui-test` is password-gated and disabled unless a `host_vars` file opts in. Verify it is off on production hosts.
* **No automated security tests exist** for roles/permissions — see [Validation / Smoke Tests](#validation--smoke-tests).

---

## Contributors

Commit authorship across the **556-commit** Mozambique product delta (`815b2374..124678e5`). **552 of these commits were authored, reviewed and merged in the upstream repository** `egovernments/Citizen-Complaint-Resolution-System` on branch `release-v2.12-moz`; the fork mirrors them.

| Contributor | Commits | Share |
|---|---:|---:|
| Hari-egov | 481 | 86.5% |
| pradeep-egov | 22 | |
| nozotrox | 19 | |
| priyanshu-egov | 11 | |
| Admin | 11 | |
| subhashini-egov | 6 | |
| Shivam Upadhyay | 3 | |
| Feliciano Mazoio | 1 | 0.2% |
| Subhashini Srinivasan | 1 | 0.2% |
| vinothrallapalli-egov | 1 | |

*Note: the per-author counts above are `git shortlog -sn 815b2374..124678e5` and sum to 556 of 556 commits. The `Admin` identity is an unresolved committer name, not a person's account.*

The release commit `124678e5` ("Create stateige.yml.example (#3)") was authored by **pradeep-egov**, co-authored by **priyanshu-egov**.

---

*Release notes generated for `cms-mozambique-v1.0.0` (`124678e55b6f59aeba61bae753e6b00ef842dfb7`). Every factual claim above is traceable to a commit SHA or a repository path named in the text. Items that could not be verified are explicitly marked **NOT VERIFIED**.*


---

## ⚠️ Known defects in `stateige.yml.example` — READ BEFORE YOUR FIRST DEPLOY

`local-setup/ansible/inventory/host_vars/stateige.yml.example` is one of the two files this fork adds over the upstream baseline. As shipped at the release commit it is a **local-development template, not a production one**, and copying it verbatim will fail or deploy the wrong artefacts. Each item below is verified against the release commit `124678e5`.

| # | Defect (line) | Effect if not corrected | Fix before running `deploy.sh` |
|---|---|---|---|
| 1 | `enable_mcp: true` (80) with **no `docker_registry`** anywhere in the file | `preflight.py` rule `mcp-needs-registry` FAILS and `deploy.sh` exits 1 before contacting the host | set `docker_registry` to a registry the TARGET can reach |
| 2 | `digit_ui_esbuild_branch: feat/keycloak-auth-adapter` (142) | the playbook clones `/opt/digit-ui-esbuild` at a stale **feature branch**, so the SPA served is NOT this release | remove the key (playbook default `main`) or pin the intended release branch |
| 3 | `enable_digit_ui_v2: true` (141) + `digit_ui_v2_repo: https://github.com/ChakshuGautam/…` (146) | builds and serves the **legacy** digit-ui-v2 from a **third-party personal fork** | set `enable_digit_ui_v2: false` and `nginx_features.digit_ui_v2: false` |
| 4 | `novu_public_base_url: "https://cms-pilot.digit.org"` (105) | points all four Novu URLs at **someone else's live environment** | set your own domain |
| 5 | `state_root: mz` and `tenant_id: mz` (53/56) | only `mz` is provisioned, so `mz.ige` never exists — yet CMS seeding is documented against the city tenant | set `tenant_id: mz.ige` before deploying, or create `mz.ige` via MCP `/v1/tenant/bootstrap` first |
| 6 | plaintext example credentials throughout | test defaults inherited from `bomet.yml.example` | change every one for any reachable deployment |
| 7 | header still reads `bomet.yml.example … ./deploy.sh bomet`, `domain: localhost` (41) | misleading provenance and a local-only domain | update header and domain |

**None of these are fixed by `cms-mozambique-v1.0.0`** — this is a documentation release and makes no code or configuration changes. They are recorded here so an operator is not surprised.
