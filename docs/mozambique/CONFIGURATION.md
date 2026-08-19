# CONFIGURATION.md — CMS Mozambique v1.0.0

Configuration and MDMS guide for **DIGIT Complaint Management System — Mozambique**.

| Field | Value |
|---|---|
| Release | `cms-mozambique-v1.0.0` — annotated tag created on `124678e5` as part of this release (not plain `v1.0.0`) |
| Release commit | `124678e55b6f59aeba61bae753e6b00ef842dfb7` (branch `master`) |
| Repository | `eGov-Global/CMS-MOZAMBIQUE` |
| Upstream baseline | `343617ceab56b28ced9ad276286d9afc0ef613a8` (`egovernments/Citizen-Complaint-Resolution-System`, branch `release-v2.12-moz`) |
| Release type | **Documentation release — no application code changes** |

Every path in this document is relative to the repository root at the release commit unless stated otherwise. Every statement is traceable to a file path in the repository; anything that could not be established from the repository is marked **NOT VERIFIED**.

> **Secrets policy.** This document never contains a credential value. Example inventory files and seed files in the repository contain example/test defaults that **MUST be changed** before any real deployment. Environment values (URLs, hostnames, IPs, bucket names, credentials) appear here only as placeholders such as `<gateway-url>`, `<state-root>`, `<city-tenant>`, `<banner-url>`.

---

## 1. How to read this document

### 1.1 The product/environment split

The single most important distinction in CCRS Mozambique configuration:

| Class | Definition | Lives in | Changes between environments? |
|---|---|---|---|
| **PRODUCT** configuration | Ships inside the release artifact. Identical on every Mozambique environment. Defines *what the application is*. | Files under `utilities/default-data-handler/src/main/resources/` (schemas, masters, workflow, localization) and `docs/migration/seed/` | No — a difference is drift, not a decision |
| **ENVIRONMENT** configuration | Chosen per box by the operator. Defines *where and for whom the application runs*. | `local-setup/ansible/inventory/host_vars/<tenant>.yml`, MDMS records created by onboarding, `digit.env`, nginx vhost, `globalConfigs.js`, OpenBao secrets | Yes — always |

A third, smaller class exists and is called out explicitly where it applies:

| Class | Definition |
|---|---|
| **POST-DEPLOYMENT NARROWING** | The product ships a superset; the operator narrows it on the live environment after deployment. The single instance in this release is `ComplaintRelatedToMap` (§8). |

### 1.2 Release-specific corrections

Parts of the internal configuration audit were captured against a branch tip *ahead* of this release. Where the audit and this release disagree, **this document states the release behaviour** and flags the difference:

| Topic | This release (`124678e5`) | Later on the upstream moz branch (not in this release) |
|---|---|---|
| Roles registered by `ccrs-migrate --cms` | **5** (`docs/migration/ccrs-migrate.cjs:763`) | 8 (CCSD-1937) |
| Deploy-time CMS seeding | **Absent** — no `ccrs-migrate` invocation exists in `local-setup/ansible/playbook-deploy.yml` | Automatic ansible `cms-seed` task (CCSD-1937) |
| Dashboard geography drill-down / analytics `boundaryPath` | **Not present** | CCSD-2171 |

---

## 2. Who seeds what — the seeding actors

Seven distinct actors write configuration. Knowing which one owns a given master is the fastest way to answer "why is this value wrong?".

| # | Actor | Invocation | Owns | Idempotent? |
|---|---|---|---|---|
| A | **Ansible deploy** | `local-setup/ansible/deploy.sh <tenant>` → `playbook-deploy.yml` | `digit.env`, `globalConfigs.js`, nginx vhost, enc-service keys, `common-masters.MobileNumberValidation`, notification masters (opt-in), configurator i18n | Yes |
| B | **MCP tenant provisioner** | `tenant_bootstrap` / `city_setup` / `city_setup_from_xlsx` (`digit-mcp/src/tools/mdms-tenant.ts`) | Schema definitions, `tenant.tenants`, boundaries, HRMS masters, `DataSecurity.*`, `common-masters.*`, `Workflow.*`, ADMIN user, employees | Yes |
| C | **default-data-handler (DDH)** | JVM service, self-seeds ~10 s after boot | Schemas + MDMS masters + config-service records + localization from its own classpath | Once per boot; never deletes |
| D | **`ccrs-migrate.cjs`** | `node docs/migration/ccrs-migrate.cjs …` | PGR schemas, complaint hierarchy, PGR masters, landing config, CMS roles/actions/grants/workflow, banner, nginx gzip | Yes — add-if-missing |
| E | **`enable-dashboard.sh`** | `local-setup/scripts/enable-dashboard.sh` | `dss.KpiDefinition` / `dss.DashboardPack` / `dss.DashboardConfig`, dashboard sidebar grant, `rainmaker-dashboard` localization | Yes (`--repair` for corrupt rows) |
| F | **Configurator (DIGIT Studio)** | Browser, day-2 | Most MDMS masters via `configurator/packages/data-provider/src/providers/resourceRegistry.ts` | n/a |
| G | **Manual / operator** | `curl`, SQL, redis-cli | Everything the above do not cover (see §11) | n/a |

> **DDH is not part of the deployed compose stack in this release.** `grep default-data-handler local-setup/docker-compose*.y*ml` returns nothing. DDH's resource tree is still the *source of truth for product configuration* — `ccrs-migrate.cjs` and the ansible notification seeder read files directly out of it (`docs/migration/ccrs-migrate.cjs:175-191`; `playbook-deploy.yml:4345-4349`) — but nothing seeds from a running DDH on an ansible-managed box. Consequences are covered in §11.6.

---

## 3. Seeding order

Order is load-bearing. A phase that runs early against a tenant that does not yet exist fails with `SCHEMA_DEFINITION_NOT_FOUND_ERR`, `INVALID_ROLE`, or a crash-looping JVM service.

```
0.  DECIDE tenancy (§4.1)                                    ── operator, before anything
1.  ANSIBLE: fill host_vars, ./deploy.sh <tenant>            ── actor A
2.  STACK UP: digit.env, globalConfigs.js, nginx, enc keys   ── actor A
3.  MCP tenant_bootstrap  (state root)                       ── actor B   ← REQUIRED before any tenant-scoped write
4.  MCP city_setup / city_setup_from_xlsx (per authority)    ── actor B   tenant → boundaries → masters → employees
5.  ccrs-migrate  (full pipeline)                            ── actor D
       auth → schemas → hierarchy → pgr-masters → landing
             → cms(--cms) → banner → gzip(--gzip) → verify
6.  MANUAL: register the 3 unseeded roles + their grants     ── actor G   (§7.3, this release only)
7.  RESTART egov-workflow-v2                                 ── actor G   (it caches BusinessServices)
8.  HAND-CORRECT country defaults (mobile / languages / TZ)  ── actor G   (§11)
9.  POST-DEPLOYMENT: narrow ComplaintRelatedToMap            ── actor G   (§8)   ← launch-shaping step
10. OPTIONAL: enable-dashboard.sh                            ── actor E   LAST — needs employees holding the roles
11. OPTIONAL: testing entrance                               ── actors A+F
12. VERIFY (§12)
```

Hard ordering constraints, each with its failure mode:

| Constraint | Failure if violated |
|---|---|
| `tenant_bootstrap` before every tenant-scoped write | `SCHEMA_DEFINITION_NOT_FOUND_ERR` / `INVALID_ROLE` on every later create |
| `DataSecurity.*` present before JVM services point at the new state root | Encryption policy `@PostConstruct` init fails; the service does not start |
| Boot-pins stay on the pre-seeded tenant until bootstrap completes | JVM tier crash-loops reading MDMS of a non-existent tenant (`playbook-deploy.yml:1406-1438` defers the rewrite for exactly this reason) |
| `schemas` phase before `hierarchy`/`pgr-masters`/`landing` | Data creates 400 |
| Roles exist before employee onboarding | `Role "CMS_…" not valid` |
| `egov-workflow-v2` restart after a new BusinessService | New workflow invisible; transitions rejected |
| Employees hold the role before `enable-dashboard.sh` | Installer step 0 stops (zero holders for a target role) |

---

## 4. Tenancy

### 4.1 Tenant ids — the tenancy model

**PRODUCT** — the authority codes are baked into the product seed. **ENVIRONMENT** — which city/testing tenants exist on a given box.

| Tenant | Role | Class |
|---|---|---|
| `mz` | State root. All state-level MDMS writes land here. | PRODUCT (referenced by seed) |
| `mz.ige` | Authority sub-tenant — IGE | PRODUCT (`docs/migration/seed/ComplaintRelatedToMap.json`) |
| `mz.igsae` | Authority sub-tenant — IGSAE | PRODUCT (same file) |
| `mz.<city>` (example: `mz.maputo`) | City tenant | ENVIRONMENT |
| `mz.<testing>` | Optional testing sub-tenant | ENVIRONMENT, optional |

- **Where the state root is derived:** `ccrs-migrate.cjs` takes the first dot-segment of `--tenant` as the state (`docs/migration/ccrs-migrate.cjs:129-147`).
- **Naming rule:** no hyphens and no digits in the city segment — `egov-user` rejects them.
- **Required:** yes. Decided at step 0.
- **Upgrade rule:** never rename an existing tenant code. `ComplaintRelatedToMap.tenantCode`, HRMS jurisdictions and every historical complaint are keyed on it.

### 4.2 `tenant.tenants`

| | |
|---|---|
| **Lives** | MDMS master at the **state root** (not at the city) |
| **Schema** | `utilities/default-data-handler/src/main/resources/schema/tenant.json` — required: `code`, `name`, `domainUrl`, `type`, `imageId`, `emailId`, `OfficeTimings`, `city`, `address`, `contactNumber`; `x-unique`: `code` |
| **Seeded by** | Actor B — `tenant_bootstrap` creates the root self-record; `city_setup` / `city_setup_from_xlsx` creates each city record |
| **Class** | ENVIRONMENT |
| **Required** | Yes |

The repository seed `mdmsData-dev/tenant/tenant.tenants.json` is the stock demo pair — it is **not** Mozambique data. There is no Mozambique `tenant.tenants` data anywhere in the release; it is operator-supplied.

An additive `isTestingTenant: true` field is written by the configurator's "Make this a testing tenant" toggle (`configurator/src/resources/tenants/TestingTenantToggle.tsx`). It is **not** in the schema — it rides as an additive property and survives update round-trips.

Verify with an MDMS search at the **root**, not the city.

### 4.3 `tenant.citymodule` (module discovery + PGR banner)

| | |
|---|---|
| **Lives** | MDMS `tenant.citymodule`, per tenant |
| **Seed** | `utilities/default-data-handler/src/main/resources/mdmsData/tenant/tenant.citymodule.json` — 3 rows: `Workbench` (order 1), `PGR` (order 2), `HRMS` (order 3), each scoped to `{tenantid}` |
| **Seeded by** | Actor D, phase `banner`; also copied by actor B `tenant_bootstrap` |
| **Class** | PRODUCT for the row set; ENVIRONMENT for the `bannerImage` URL |
| **Required** | Yes |

The Mozambique delta adds a `bannerImage` string property to the `tenant.citymodule` schema (`schema/tenant.json:34`) so the PGR row can carry the landing/home banner.

- `ccrs-migrate --phases banner --banner-url <banner-url>` registers the schema from the DDH seed, creates **missing rows only**, and fills `PGR.bannerImage` **only when empty**.
- Overwriting an already-set banner requires **both** an explicit `--banner-url` **and** `--update-masters`.
- If the environment's schema predates `bannerImage`, the runner reports `CITYMODULE_SCHEMA_DRIFT` and attempts `docs/migration/fix-citymodule.sh <state>` on-box (SQL patch + `egov-mdms-service` restart). MDMS has **no schema-update API** — SQL is the only route (§11.5).
- A `Dashboard` row in this master gates the dashboard home card.

---

## 5. Boundary hierarchy

| | |
|---|---|
| **Lives** | boundary-service: hierarchy definition + entities + relationships, created at the **CITY** tenant (hierarchies do **not** inherit from the root) |
| **Product reference files** | `utilities/default-data-handler/src/main/resources/boundary/hierarchy-definition/hierarchy.json`, `.../boundary/entity/entity.json`, `.../boundary/relationship/relationship.json` — demo taxonomy `City > Zone > Ward`, **not** Mozambique data |
| **Seeded by** | Actor B — `city_setup_from_xlsx`, phase 2 (`boundaries`), from the operator's `boundaries.xlsx` |
| **Class** | ENVIRONMENT |
| **Required** | Yes — before employees and before any complaint |

Mozambique taxonomy is Município → (Distrito Municipal) → Bairro → (Quarteirão). When the sheet's levels do not match the root's, the wizard auto-creates a `<CITY_PORTION>_ADMIN` hierarchy.

Pre-flight the spreadsheet: strip whitespace, drop duplicate `code` rows, assert zero unresolved `parentCode`. Verify afterwards with `validate_boundary_hierarchy` at the **city** tenant (checks valid / owner_matches / order_matches).

**Related master — `CMS-BOUNDARY.HierarchySchema`** (`mdmsData/egov-bndry-mgmnt/CMS-BOUNDARY.HierarchySchema.json`) declares the highest/lowest hierarchy used by module boundary pickers. The shipped rows are:

```
moduleName CMS  | department All | hierarchy ADMIN | highestHierarchy Zone | lowestHierarchy Locality
moduleName HRMS | department All | hierarchy ADMIN | highestHierarchy Zone | lowestHierarchy Locality
```

These are the generic defaults, **not** the Mozambique level names — an environment using Município/Bairro must align this master with `pgr_boundary_highest_level` / `pgr_boundary_lowest_level` in `host_vars` (§10).

Adding a level changes `hierarchyType`, which the SPA reads from `globalConfigs.HIERARCHY_TYPE` — a level change therefore requires an inventory edit plus a `globalConfigs` re-render. There is no boundary delete API in this flow; to redo a taxonomy, onboard onto a fresh city tenant.

**NOT VERIFIED:** the concrete boundary data for any Mozambique tenant — it is operator-loaded from XLSX and does not exist in the repository.

---

## 6. Localization

### 6.1 Locales

| Locale | Status in this release |
|---|---|
| `default` | Present |
| `en_IN` | Present — `rainmaker-pgr` substantially reworked in the Mozambique line |
| `hi_IN` | Present — upstream residue. **NOT VERIFIED** whether its retention for Mozambique is intentional |
| `pt_PT` | **Added by the Mozambique line** — `localisations/pt_PT/rainmaker-common.json` (61 keys) and `localisations/pt_PT/rainmaker-pgr.json` (283 keys) |

`utilities/default-data-handler/src/main/resources/application.properties:63`:

```
default.localization.locale.list=en_IN,hi_IN,pt_PT
```

`pt_PT` message packs exist **only** for `rainmaker-common` and `rainmaker-pgr`. Any other module rendered under `pt_PT` falls back per the SPA's i18n behaviour; the dashboard is the exception: `enable-dashboard.sh` seeds a 322-message `rainmaker-dashboard` pack for **both** `en_IN` and `pt_PT`, so it is covered once the dashboard is installed — it renders raw keys only if that optional step is skipped.

### 6.2 Modules

`application.properties:64`:

```
default.localization.module.create.list=digit-ui,digit-sandbox,rainmaker-common,digit-privacy-policy,
  rainmaker-pgr,rainmaker-hr,rainmaker-workbench,rainmaker-mdms,rainmaker-schema
```

Plus, outside that list:
- `digit-tenants` — seeded as a tenant localization module
- `rainmaker-dashboard` — seeded separately by `enable-dashboard.sh` (322 messages per locale, from `local-setup/db/dss-mdms-seed/l10n/{en_IN,pt_PT}.json`; `enable-dashboard.sh:22` still says 315)
- Configurator i18n — seeded by an ansible task

### 6.3 Ownership and rules

| | |
|---|---|
| **Class** | PRODUCT (message content) + ENVIRONMENT (which locales a tenant offers, via `StateInfo.languages`) |
| **Seeded by** | Actor C (`LocalizationUtil` globs `classpath:localisations/*/*.json`) for the DDH-owned tenant; Actor D `landing` phase for `PGR_LANDING_*` keys; Actor G for everything else |
| **Required** | Yes |

Two hard rules:

1. **One locale per upsert call.** A batch mixing locales is silently dropped.
2. **Cache invalidation is mandatory.** After *any* localization upsert the UI keeps serving stale text until the Redis computed-message caches are evicted. Restarting `egov-localization` alone does **not** evict them. Flush the computed-message cache keys on the Redis container, then hard-refresh the SPA. `enable-dashboard.sh` bakes a cache-bust into its localization step for this reason.

`ccrs-migrate`'s `landing` phase seeds **only missing** keys — existing messages are never overwritten, so operator edits made in the Landing Builder are never reset. There is no delete; to revert, re-upsert the previous text.

### 6.4 Language picker — `common-masters.StateInfo`

| | |
|---|---|
| **Lives** | MDMS `common-masters.StateInfo`, per tenant |
| **Seed** | `mdmsData/common-masters/common-masters.StateInfo.json` |
| **Seeded by** | Actor B (`tenant_bootstrap` copies it from the source root), then hand-edited |
| **Class** | ENVIRONMENT |
| **Required** | Yes |
| **Configurator screen** | "Branding" |

Drives logos, banner, default URLs, the language dropdown (`languages[]`) and which localization modules the SPA loads (`localizationModules[]`).

> **GAP — verified in this release.** The shipped `languages[]` contains **only** `en_IN` ("ENGLISH") and `hi_IN` ("हिंदी"). **`pt_PT` is absent.** No seeder anywhere adds it. A fresh Mozambique environment therefore ships full Portuguese message packs with **no way to select Portuguese in the picker**. The operator must add an entry of the form `{ "label": "Português", "value": "pt_PT" }` by hand.
> **NOT VERIFIED:** whether `pt_PT` has been added to `StateInfo.languages` on any running Mozambique environment.

Also set per environment: `logoUrl`, `logoUrlWhite`, `statelogo`, `bannerUrl`, `qrCodeURL` (all ship pointing at demo assets), and confirm `localizationModules[]` covers `rainmaker-common`, `rainmaker-pgr`, `rainmaker-hr`, `rainmaker-workbench` (+ `rainmaker-dashboard` when the dashboard is enabled).

---

## 7. MDMS masters

### 7.1 Schema registration — the first write phase

| | |
|---|---|
| **Lives** | `eg_mdms_schema_definition` (MDMS v2) |
| **Product files** | `schema/RAINMAKER-PGR.json` (12 schemas), `schema/rainmaker-pgr-landing.json` (2), `schema/tenant.json` (`tenants`, `citymodule`), `schema/commonMDMSConfig.json` (`PrivacyPolicy`), `schema/IgeComplaintExtendedAttributes.json`, `schema/IgsaeComplaintExtendedAttributes.json` |
| **Seeded by** | Actor D, phase `schemas` (or `docs/migration/install-schemas.cjs`); actor B copies all schema definitions on `tenant_bootstrap` |
| **Class** | PRODUCT |
| **Required** | Yes — every data phase depends on it |

The 12 `RAINMAKER-PGR` schemas, verified at the release commit:

```
RAINMAKER-PGR.UIConstants
RAINMAKER-PGR.EscalationConfig
RAINMAKER-PGR.ComplaintHierarchyDefinition
RAINMAKER-PGR.ComplaintHierarchy
RAINMAKER-PGR.NotificationRouting
RAINMAKER-PGR.NotificationTemplate
RAINMAKER-PGR.NotificationProviderTemplate
RAINMAKER-PGR.MapConfig
RAINMAKER-PGR.InboxVisibilityConfig
RAINMAKER-PGR.ComplaintRelatedToMap
RAINMAKER-PGR.ComplaintTemplateType
RAINMAKER-PGR.ComplaintExtendedAttributeSchema
```

Plus `RAINMAKER-PGR.LandingSection` and `RAINMAKER-PGR.LandingPageConfig`. All carry `tenantId: {tenantid}`.

Two environment quirks the runner already handles, listed because they still require operator action when they bite:

- **Async persist.** Schema creates return 202 on some stacks; the runner sleeps 6 s and verifies. A silently-dropped create needs a direct insert into `eg_mdms_schema_definition` plus `docker restart egov-mdms-service`.
- **`x-ref-schema` `[]` → `{}`.** MDMS stores an empty `x-ref-schema` array as an object on create, which 400s the first data write. Fix with `UPDATE eg_mdms_schema_definition SET definition = jsonb_set(definition, '{x-ref-schema}', '[]'::jsonb) …` then restart `egov-mdms-service`. **Re-running DDH can revert this fix** — re-apply after any DDH re-seed (`docs/migration/operator-runbook.md` §3c). No automation guards this.

### 7.2 `ACCESSCONTROL-ROLES.roles`

| | |
|---|---|
| **Lives** | MDMS, at **both** the state root and the city tenant (role rows do not overlay state→city; the configurator's employee-upload validator reads the **city** tenant) |
| **Seed** | `mdmsData/ACCESSCONTROL-ROLE/ACCESSCONTROL-ROLES.roles.json` |
| **Seeded by** | Actor D, phase `cms` (opt-in `--cms` / `--only cms`) |
| **Class** | PRODUCT |
| **Required** | Yes |

Seven `CMS_*` roles ship in the seed file (verified at `124678e5`):

```
CMS_ADMIN   CMS_CASE_MANAGER   CMS_DASHBOARD_VIEWER   CMS_RECEPTION_OFFICER
CMS_SCREENING_OFFICER   CMS_SUPERVISOR   CMS_VIEWER
```

The Mozambique line also adds `DGRO`, `CENTRAL_USER`, `DEPARTMENT_USER`, `COMPLAINTS_VIEWER`, `COMPLAINTS_EDITOR`, `COMPLAINTS_CREATOR`, `CONFIDENTIAL_COMPLAINT_VIEWER`.

> **KNOWN LIMITATION — role registration gap in this release.**
> `docs/migration/ccrs-migrate.cjs:763` registers exactly **five**:
> ```js
> const CMS_ROLES = ['CMS_RECEPTION_OFFICER', 'CMS_SCREENING_OFFICER', 'CMS_SUPERVISOR', 'CMS_CASE_MANAGER', 'CMS_VIEWER'];
> ```
> `CMS_ADMIN`, `CMS_DASHBOARD_VIEWER` and `CONFIDENTIAL_COMPLAINT_VIEWER` are **not auto-registered**, although features that need them **are** in the release (admin search, dashboard view gating, confidential-field visibility). **Manual registration is required** — see §7.3 for the grants this also skips.

MCP `tenant_bootstrap` clones roles from the stock source tenant, which predates the CMS taxonomy — the CMS roles must come from `ccrs-migrate --only cms`, run after ADMIN provisioning and before employee onboarding.

After any role change, users must **re-login** (three stacked caches). To retire a role, deactivate the row and revoke the HRMS assignment.

### 7.3 `ACCESSCONTROL-ACTIONS-TEST.actions-test` + `ACCESSCONTROL-ROLEACTIONS.roleactions`

| | |
|---|---|
| **Lives** | MDMS, at the **state root** (unlike roles, which go to state **and** city) |
| **Seed** | `mdmsData/ACCESSCONTROL-ACTIONS-TEST/ACCESSCONTROL-ACTIONS-TEST.actions-test.json` (catalog) and `mdmsData/ACCESSCONTROL-ROLEACTIONS/ACCESSCONTROL-ROLEACTIONS.roleactions.json` (grants) |
| **Seeded by** | Actor D, phase `cms`; the dashboard sidebar grant by actor E |
| **Class** | PRODUCT |
| **Required** | Yes |

The grants seed carries **731 grants across 29 role codes** (verified count). Per CMS role:

| Role | Grants in seed | Seeded by `--cms` in this release |
|---|---|---|
| `CMS_SCREENING_OFFICER` | 37 | ✅ |
| `CMS_SUPERVISOR` | 37 | ✅ |
| `CMS_CASE_MANAGER` | 37 | ✅ |
| `CMS_VIEWER` | 37 | ✅ |
| `CMS_RECEPTION_OFFICER` | 33 | ✅ |
| `CMS_DASHBOARD_VIEWER` | 24 | ❌ |
| `CMS_ADMIN` | 22 | ❌ |
| `CONFIDENTIAL_COMPLAINT_VIEWER` | 16 | ❌ |

> **Consequence of the §7.2 gap.** `ccrs-migrate.cjs:811` filters grants by the same 5-role list:
> ```js
> const grants = readJson(SEED.roleactions).filter((g) => CMS_ROLES.includes(g.rolecode));
> ```
> So the `cms` phase applies **181 of the 243** CMS-related grants. The **62 grants** for `CMS_ADMIN`, `CMS_DASHBOARD_VIEWER` and `CONFIDENTIAL_COMPLAINT_VIEWER` are not applied either. Register those three roles **and** their grants manually (the rows already exist in the two seed files — copy them out and POST them to MDMS at the appropriate tenants).

Other facts:
- The `cms` phase creates only action ids referenced by CMS grants, and only missing grants. A grant referencing an action id absent from the catalog seed is **reported** as "not in catalog seed", not silently skipped.
- Two citizen sidebar actions were repointed from `/digit-ui/citizen/all-services` to `/digit-ui/citizen/pgr-home`.
- The dashboard sidebar action id is `4557` (`enable-dashboard.sh:132`).
- **After any grant change, flush the OAuth token store and re-login.** This is mandatory, not advisory.

> **SECURITY — related and unresolved.** `POST /pgr-services/v2/request/_admin/_search` has **no server-side authorization gate**: no `ACCESSCONTROL` action is registered for the URI (0 hits in both action masters), there is no `@PreAuthorize`, and there is no Kong route entry. `AdminComplaintSearchService` validates only `tenantId` and sets `skipEmployeeDepartmentScope(true)`, deliberately bypassing department ABAC; its two "SUPERUSER" mentions are comments. Proven on the cms-pilot environment: a user holding only `CMS_SCREENING_OFFICER` + `EMPLOYEE` received HTTP 200 with complaint rows. The only gate is client-side — `ADMIN_SEARCH_ROLES = ["SUPERUSER", "CMS_ADMIN"]` at `digit-ui-esbuild/products/pgr/src/pages/employee/AdminSearch.js:267` — and is bypassable by calling the API directly. **Not fixed in this documentation-only release.** Recommended fix: enforce the role in the service/controller, or register the action plus a `roleactions` grant.

### 7.4 PGR workflow BusinessService — CMS variant

| | |
|---|---|
| **Lives** | `egov-workflow-v2`, one `BusinessService` named `PGR` per tenant, created at the **city** tenant |
| **Product file** | `utilities/default-data-handler/src/main/resources/CmsPgrWorkflowConfig.json` |
| **Selected by** | `pgr.workflow.variant` — `standard` (default) → `PgrWorkflowConfig.json`; `cms` → `CmsPgrWorkflowConfig.json` (`DataHandlerService.java:64`) |
| **Seeded by** | Actor D, phase `cms` step 4; or actor C at tenant creation |
| **Class** | PRODUCT |
| **Required** | Yes |

State machine:

| From | Action → To | Roles |
|---|---|---|
| — | `APPLY` → `PENDINGFORASSIGNMENT` | `CITIZEN`, `CMS_RECEPTION_OFFICER` |
| `PENDINGFORASSIGNMENT` | `ASSIGN` / `REFERRED`, `REJECT` | `CMS_SCREENING_OFFICER`, `CMS_VIEWER` |
| `REFERRED` | `ASSIGN` → `INVESTIGATION`, `REJECT`, `REASSIGN` → `PENDINGFORREASSIGNMENT` | `CMS_SUPERVISOR`, `CMS_VIEWER` |
| `INVESTIGATION` | `AWAITINGINFORMATION` / `INFOFROMCITIZEN`, `REJECT`, `RESOLVE` | `CMS_CASE_MANAGER`, `CMS_VIEWER` |
| `INFOFROMCITIZEN` | `COMMENT` → `INVESTIGATION` | — |
| `RESOLVED` / `REJECTED` | terminal, with `RATE` / `REOPEN` / `COMMENT` | — |
| `CLOSEDAFTERRESOLUTION`, `CLOSEDAFTERREJECTION`, `CANCELLED` | terminal | — |

Rules:
- The variant is **per deployment** — one `BusinessService` per tenant.
- **Restart `egov-workflow-v2`** after creating it; it caches BusinessServices.
- `ccrs-migrate` does **not** patch an existing BusinessService in place (it reports "already present"). Changing a live state machine requires the `--update-wf` path.
- Rollback = re-POST the previous definition, then restart `egov-workflow-v2`.

> **Verified difference from the standard variant:** `CmsPgrWorkflowConfig.json` contains **zero** `notifications` blocks (`grep -c notifications` → 0; the same grep on `PgrWorkflowConfig.json` → 3). See §7.9.

> **KNOWN LIMITATION — `PGR_WORKFLOW_VARIANT` is not set anywhere.** `grep -rn PGR_WORKFLOW_VARIANT` over the release returns **nothing**, and `default-data-handler` is absent from every compose file. The only reference to the switch is the Java default `@Value("${pgr.workflow.variant:standard}")`. On an ansible-managed box the CMS BusinessService therefore arrives **only** via `ccrs-migrate --cms` (which posts `CmsPgrWorkflowConfig.json` explicitly and does not consult the property). Operators running DDH out-of-band must set `pgr.workflow.variant=cms` before its first boot. This item is carried as **NEEDS VERIFICATION** in the release notes.

### 7.5 Complaint hierarchy — `ComplaintHierarchyDefinition` + `ComplaintHierarchy`

| | |
|---|---|
| **Lives** | MDMS, per authority sub-tenant |
| **Model** | Two-master N-level model replacing the legacy 2-level `ServiceDefs`. The **Definition** declares the ordered levels (demo: `hierarchyType: PGR`, `CATEGORY` → `SUB_TYPE`, `isLeafServiceCode` on the leaf). **ComplaintHierarchy** is a single adjacency list holding interior nodes and leaves; leaves carry `department`, `slaHours`, `keywords`, `path`. |
| **Seeded by** | Actor B (`city_setup_from_xlsx`, masters phase) for a fresh tenant; actor D phase `hierarchy` for a migration; configurator for day-2 edits |
| **Class** | ENVIRONMENT (taxonomy is per authority) |
| **Required** | Yes |

- **Deliberately excluded from `tenant_bootstrap`** — `digit-mcp/src/tools/mdms-tenant.ts` carries an explicit exclusion comment; the taxonomy is tenant-specific and operator-loaded.
- **Leaf `keywords` must serialise as a comma-separated STRING.** A JSON array is rejected: `expected type: String, found: JSONArray`.
- **Codes are kept verbatim** across the 2-level→N-level cutover — renaming orphans historical complaints.
- The runner self-skips when leaf rows already carry `department`/`slaHours`.
- Cutover is lockstep and human-checkpointed: backup → install schemas → `x-ref` jsonb fix → `preflight-dryrun.cjs` → migrate per tenant → deploy `pgr-services` → **re-apply the `x-ref` fix** → verify → retire old masters (`docs/migration/operator-runbook.md` §§1-5).
- Rollback = `pg_restore` the pre-migration dump plus redeploy the previous `pgr-services` image and frontend (`operator-runbook.md` §6).

**NOT VERIFIED:** the concrete hierarchy content for `mz.ige` and `mz.igsae` — operator-loaded from XLSX, not in the repository.
**NOT VERIFIED:** whether `RAINMAKER-PGR.ServiceDefs` is fully retired — `ccrs-migrate`'s hierarchy phase still reads it as a migration source, and dashboard documentation still references `ServiceDefs.slaHours`, so both models may coexist somewhere.

### 7.6 `ComplaintRelatedToMap` — the authority dispatcher

| | |
|---|---|
| **Lives** | MDMS `RAINMAKER-PGR.ComplaintRelatedToMap` at the **state** tenant; sub-tenants inherit |
| **Product seed** | `docs/migration/seed/ComplaintRelatedToMap.json` |
| **Seeded by** | Actor D, phase `pgr-masters` (uid = `code`); or `docs/migration/seed-pgr-masters.cjs` |
| **Class** | PRODUCT — then **narrowed post-deployment** (§8) |
| **Required** | Yes, for the citizen 3-step wizard |

Shipped content, verbatim at the release commit:

```json
[
  { "code": "IGE",   "name": "PGR_RELATEDTO_NAME_IGE",   "shortName": "IGE",
    "tenantCode": "mz.ige",   "tenantId": "mz", "displayOrder": 1, "active": true },
  { "code": "IGSAE", "name": "PGR_RELATEDTO_NAME_IGSAE", "shortName": "IGSAE",
    "tenantCode": "mz.igsae", "tenantId": "mz", "displayOrder": 2, "active": true }
]
```

`name` is a **localization key**, not display text — `PGR_RELATEDTO_NAME_IGE` / `PGR_RELATEDTO_NAME_IGSAE` must exist in `rainmaker-pgr` for every offered locale or the dropdown renders raw keys. The frontend reads this master at the state tenant and resolves the sub-tenant invisibly.

Default seeding is **strictly add-if-missing**; drifted rows are warned about and only synced with `--update-masters`. To disable a row, set `active: false` — the wizard then falls back to the non-dispatcher flow.

> **A stale design document exists.** `docs/agency-category-tenant-mapping.md` documents an MDMS master `RAINMAKER-PGR.AuthorityConfig` as the authority→tenant mapping. **That master does not exist** anywhere in code, schema or seed — the implemented master is `ComplaintRelatedToMap`. Ignore the design doc; it will mislead.

### 7.7 `ComplaintTemplateType`

| | |
|---|---|
| **Lives** | MDMS at the **state** tenant, keyed by `caseRelatedTo` (FK to `ComplaintRelatedToMap.code`) |
| **Product seed** | `docs/migration/seed/ComplaintTemplateType.json` |
| **Seeded by** | Actor D, phase `pgr-masters` (uid = `caseRelatedTo`) |
| **Class** | PRODUCT |
| **Required** | Yes, wherever `ComplaintRelatedToMap` is seeded |

```json
[
  { "caseRelatedTo": "IGE",   "active": true, "schemaRef": "IgeComplaintExtendedAttributes",
    "allowedDocumentTypes": ["EVIDENCE"], "allowedViewerRoles": ["CONFIDENTIAL_COMPLAINT_VIEWER"] },
  { "caseRelatedTo": "IGSAE", "active": true, "schemaRef": "IgsaeComplaintExtendedAttributes",
    "allowedDocumentTypes": ["EVIDENCE"], "allowedViewerRoles": ["CONFIDENTIAL_COMPLAINT_VIEWER"] }
]
```

Note that `allowedViewerRoles` references `CONFIDENTIAL_COMPLAINT_VIEWER` — one of the three roles this release does **not** auto-register (§7.2). Setting `active: false` stops dynamic fields rendering for that category.

### 7.8 `ComplaintExtendedAttributeSchema` — dynamic fields, `x-security`, `x-no-mask`

| | |
|---|---|
| **Lives** | MDMS at the **state** tenant, one draft-07 JSON Schema per `schemaRef` |
| **Product seed** | `docs/migration/seed/ComplaintExtendedAttributeSchema.json` |
| **Seeded by** | Actor D, phase `pgr-masters` (uid = `schemaRef`) |
| **Class** | PRODUCT |
| **Required** | Yes |

Verified content:

| `schemaRef` | `required` | `x-security` (encrypted/masked) | `x-no-mask` |
|---|---|---|---|
| `IgeComplaintExtendedAttributes` | `instituteName` | `instituteName`, `witnessName`, `witnessAddress`, `witnessNote` | `instituteName` |
| `IgsaeComplaintExtendedAttributes` | `dateOfFact`, `entityName`, `entityAddress` | `dateOfFact`, `entityName`, `entityAddress`, `witnessName`, `witnessAddress`, `witnessNote` | `entityAddress`, `entityName` |

Field metadata per property: `x-order` (form order), `x-label-key` (localization key), `x-widget` (control type). `x-label-key` values must exist in `rainmaker-pgr` localization or the form renders raw keys.

`x-no-mask` is a Mozambique addition: `pgr-services` reads it into `ComplaintTemplateTypeConfig.noMaskFields` (`backend/pgr-services/src/main/java/org/egov/pgr/util/MDMSUtils.java:478`) and leaves those fields visible — decrypting when needed — for callers lacking `CONFIDENTIAL_COMPLAINT_VIEWER`.

> **This is the canonical drift case.** An environment seeded before `x-no-mask` existed will not receive it, because the default is add-if-missing. Sync with `ccrs-migrate --phases pgr-masters --update-masters`.

### 7.9 Notification masters — `NotificationRouting` / `NotificationTemplate` / `NotificationProviderTemplate`

| Master | Answers |
|---|---|
| `RAINMAKER-PGR.NotificationRouting` | **Who** — one row per (businessService, action, toState, audience, channel) |
| `RAINMAKER-PGR.NotificationTemplate` | **What** — body + placeholders per (audience, action, toState, channel, locale) |
| `RAINMAKER-PGR.NotificationProviderTemplate` | **How delivered** — e.g. WhatsApp `contentSid` / template name / variables per locale |

| | |
|---|---|
| **Lives** | MDMS at the state root |
| **Seed data** | `mdmsData-dev/RAINMAKER-PGR/RAINMAKER-PGR.Notification{Routing,Template,ProviderTemplate}.json` |
| **Seeded by** | **Actor A** — the ansible notification-seed tasks (`playbook-deploy.yml:4327-4375`), which stage `schema/RAINMAKER-PGR.json` + the 3 data files + `local-setup/scripts/seed-notifications.py` on the target and run the seeder; **or** actor F (configurator) |
| **Class** | PRODUCT (content) / ENVIRONMENT (which are enabled) |
| **Required** | Optional — gated by `pgr.notification.config.driven` |

Ansible invocation:

```
# fresh install: automatic when `seed_notifications` (or pgr_notification_config_driven) is true
# add-on to an existing deploy:
./deploy.sh <tenant> --tags notifications
```
The task is idempotent (MDMS dedupes on re-run) and gated on both a `DONE` marker and a zero exit code.

> **Why this path exists.** DDH normally *harvests* notification rows from the workflow config's per-action `notifications` blocks and emits them as MDMS rows (`DataHandlerService.java:485-583`). `CmsPgrWorkflowConfig.json` carries **no** `notifications` blocks, so the CMS variant produces **zero** rows by that route. The ansible seeder is the supported alternative for Mozambique. The playbook comment states plainly that the deploy does not invoke DDH and that the fast-path DB dump carries no notification rows.

To turn config-driven notifications on: set `pgr.notification.config.driven=true` (env `PGR_NOTIFICATION_CONFIG_DRIVEN`) plus `pgr.notification.default.locale`, and seed routing + template rows per action/locale. The MDMS cache TTL is 60 s (`pgr.notification.mdms.cache.ttl.ms`), so configurator edits go live without a restart. The default is `false` = legacy hardcoded path, so an upgrade is **inert** until the flag is flipped. Rollback = set the flag back to `false`.

### 7.10 config-service notification config

Separate config-service records — `NotificationChannel`, `ProviderDetails`, `TemplateBinding` — loaded from `utilities/default-data-handler/src/main/resources/configData/**/*.json` via `/config-service/config/v1/_create/{configCode}`.

| Record | Contents |
|---|---|
| `NotificationChannel` | Enables channels (e.g. WHATSAPP via provider `twilio`) |
| `ProviderDetails` | Per-channel provider credentials — ships with `<placeholder>` tokens |
| `TemplateBinding` | Maps eventName + locale + channel → provider content id / template id |

| | |
|---|---|
| **Seeded by** | Actor C at boot (after MDMS data, before localization) — and therefore **not seeded by the ansible deploy path** in this release |
| **Class** | ENVIRONMENT |
| **Required** | Optional |

> **SECURITY.** `configData/TemplateBinding.json` contains committed API-key values. Treat them as leaked and **rotate before any real deployment**; replace every placeholder in `ProviderDetails.json` with per-environment values sourced from the secret store (`secrets_path` in `host_vars`). Never commit real values.

**NOT VERIFIED:** the concrete provider credentials any Mozambique environment uses.

### 7.11 `DataSecurity.*`

`DataSecurity.EncryptionPolicy`, `DataSecurity.DecryptionABAC`, `DataSecurity.MaskingPatterns`, `DataSecurity.SecurityPolicy` (`mdmsData/DataSecurity/`).

| | |
|---|---|
| **Seeded by** | Actor B — `tenant_bootstrap` step 3 |
| **Class** | ENVIRONMENT |
| **Required** | **Yes — blocking.** Every service embedding `egov-enc-service` (PGR, user, inbox) fails its encryption-policy `@PostConstruct` init and **will not start** without these records |

This is why the playbook defers the `STATE_LEVEL_TENANT_ID` rewrite until after MCP bootstrap (`playbook-deploy.yml:1406-1408`) — the JVM tier boots against the pre-seeded source tenant's data first. The enc-service key is resolved by `tenantId` inside the service (no `keyId`). Configurator exposes these masters, with `encryption-policy` gated to `MDMS_ADMIN` / `SUPERUSER` write roles.

### 7.12 `commonMDMSConfig.PrivacyPolicy`

| | |
|---|---|
| **Lives** | MDMS `commonMDMSConfig.PrivacyPolicy`, one record per `module` |
| **Schema** | `schema/commonMDMSConfig.json` — requires `module`, `header`, `contents`; `x-unique` on `module` |
| **Seed** | `mdmsData/commonMDMSConfig/commonMDMSConfig.PrivacyPolicy.json` |
| **Seeded by** | Actor C (schema + data at boot) |
| **Class** | PRODUCT |
| **Required** | Yes, for the login/consent checkbox |

Content is carried as localization keys (`CCRS_PRIVACY_HEADER`, `CCRS_PRIVACY_SECTION_1`, `CCRS_PRIVACY_P1..P6`), which must exist in **every offered locale**.

The SPA resolves the module name from `globalConfigs.UICONFIG_MODULENAME` (= ansible `config_module_name`, default `commonMDMSConfig`). The DDH schema-create list was **corrected** in the Mozambique line from `commonUiConfig.PrivacyPolicy` to `commonMDMSConfig.PrivacyPolicy` (`application.properties:54`). An environment seeded from the old list has the wrong schema code and needs the new schema registered plus the rows re-created under the corrected code.

### 7.13 Landing page — `LandingSection` + `LandingPageConfig`

| | |
|---|---|
| **Lives** | MDMS at the state tenant |
| **Seed** | `mdmsData/RAINMAKER-PGR/RAINMAKER-PGR.LandingSection.json` (10 rows) and `.../RAINMAKER-PGR.LandingPageConfig.json` (1 row) |
| **Seeded by** | Actor D, phase `landing`; or `docs/migration/landing-config/seed-landing-config.sh <gateway-url> <state-root>` |
| **Class** | PRODUCT |
| **Required** | Yes, for the public landing page |

The 10 sections, verified in order (all `enabled: true`):

```
navigation 10 · hero 30 · types 40 · steps 50 · channels 60
privacy 70 · news 80 · institutions 90 · cta 100 · footer 110
```

`LandingPageConfig` singleton, verbatim:

```json
[{ "code": "default", "enabled": true, "defaultLocale": "pt_PT",
   "showWhatsAppFab": true, "showUtilityBar": true }]
```

Note `defaultLocale: "pt_PT"` — the Mozambique landing page defaults to Portuguese. Text comes from `PGR_LANDING_*` localization keys in `en_IN` and `pt_PT`. Editable through the configurator ("Landing Sections" / "Landing Page Settings") and the visual Landing Builder. Rows are create-if-missing and localization keys are seeded only when absent, so Builder edits are never reset. To switch the page off without losing content, set `LandingPageConfig.enabled = false`.

### 7.14 DSS dashboard catalog

| | |
|---|---|
| **Lives** | MDMS at the state root: `dss.KpiDefinition`, `dss.DashboardPack`, `dss.DashboardConfig` |
| **Seed** | `ansible/nairobi-mdms/mdms/dss/` — 40 KPI definitions; 2 packs (`supervisor-default`, 11 tiles; `public-default`, 8 tiles, PUBLIC); one `DashboardConfig` `default` |
| **Seeded by** | Actor E — `local-setup/scripts/enable-dashboard.sh` (`DSS_DATA_DIR` defaults to that directory) |
| **Class** | ENVIRONMENT |
| **Required** | Optional — only when the dashboard is enabled. Run **last** |

The shipped `DashboardConfig`, verbatim:

```json
[{ "tenantId": "ke",
   "data": { "id": "default",
     "allowedRoles": ["SUPERVISOR","PGR_SUPERVISOR","GRO","DGRO","PGR_LME","PGR_ADMIN","SUPERUSER"],
     "numberFormat": { "en_IN": "#,##0.00", "pt_PT": "#.##0,00", "fr_FR": "# ##0,00", "default": "#,##0.00" },
     "publicDashboardEnabled": true,
     "timeZone": "Africa/Nairobi" } }]
```

Three things are wrong for Mozambique out of the box: `tenantId`, `allowedRoles` (contains **no** `CMS_*` role), and `timeZone`. The installer remaps roles; `timeZone` must be edited by hand.

Installation shape (placeholders only):

```
DASHBOARD_TENANT=<state-root> \
ROLE_MAP="PGR_SUPERVISOR=CMS_SUPERVISOR,PGR_LME=CMS_CASE_MANAGER" \
DASHBOARD_ALLOWED_ROLES="SUPERVISOR,SUPERUSER,GRO,DGRO,CMS_SUPERVISOR" \
./local-setup/scripts/enable-dashboard.sh --dry-run     # then --repair / normal run
```

It registers 3 schemas, seeds catalog + pack + config, grants sidebar action `4557`, seeds the `rainmaker-dashboard` localization per locale, flushes the OAuth token store, and verifies. Step 0 **stops** if a target role has zero holders — onboard employees first.

Two traps:
- **Never POST a schema body to `/v2/_create/<schema>`.** It occupies the `uniqueIdentifier` and every later seed 409s. `--repair` deactivates such rows.
- **Do not rely on `tenant_bootstrap` to copy `dss.*`** — it copies zero records when the source root has no catalog and still reports success.
- **Never invent a role.** A KPI's RBAC, the pack personas and `DASHBOARD_ALLOWED_ROLES` must all agree.

Rollback: deactivate the `dss` rows (`--repair`) and re-seed; remove the role from `allowedRoles` to hide the card and route.

**NOT VERIFIED:** the pinned content of the `local-setup/ansible/nairobi-mdms` submodule. The files read for this document came from the non-submodule `ansible/nairobi-mdms/` tree, which is what `enable-dashboard.sh` actually reads via `DSS_DATA_DIR`.

### 7.15 Optional per-tenant PGR masters

All ENVIRONMENT class, all optional, all seedable any time after the `schemas` phase.

| Master | Purpose | Resolution order |
|---|---|---|
| `RAINMAKER-PGR.MapConfig` (id `code`) | `baseMapTheme`, `tileUrl`/`attribution`, `wardHighlightColor`, `center`, zoom bounds, `boundaryTenantId`, `geocodeCountryCodes`, `searchViewbox`. Every field optional. | MDMS → `globalConfigs` → built-in |
| `RAINMAKER-PGR.UIConstants` | `REOPENSLA` | MDMS → built-in |
| `RAINMAKER-PGR.EscalationConfig` | `maxDepth`, `defaultSlaByLevel` (+ `enabledByLevel`/overrides) | Absent → `pgr-services` 5-day default |
| `RAINMAKER-PGR.InboxVisibilityConfig` | `enabled` flag + `version`/`reporteeDepth`/`jurisdictionScoped`/`serverSide` | Pure MDMS flip — no frontend redeploy |

The Mozambique line makes `useMapConfig(tenantIdOverride)` read `MapConfig` at the **authority-resolved sub-tenant**. The `tenantId` must ride inside the MDMS v2 argument or the hook falls back to the logged-in tenant.

Only `MapConfig` is worth seeding on day 1 (map centre, tiles, `boundaryTenantId`). The configurator has descriptors for `map-config` and `pgr-ui-constants` — edit without redeploy. Deleting or deactivating a record falls back to `globalConfigs`, then to built-in defaults.

---

## 8. POST-DEPLOYMENT: single-authority narrowing (required for an IGE-only launch)

**This is a deliberate product/environment split, not a bug.**

The product seed `docs/migration/seed/ComplaintRelatedToMap.json` ships **both** authorities active — `IGE → mz.ige` and `IGSAE → mz.igsae` (§7.6). The product is multi-authority by design.

For a **single-authority launch**, the operator narrows the **environment** after deployment so that exactly **one** row is active. The citizen flow then auto-selects that authority and **hides the authority picker**, collapsing the wizard by one step.

### Procedure

1. Deploy and seed normally (`ccrs-migrate --phases pgr-masters` writes both rows).
2. On the live environment, deactivate the row that is not launching — set `active: false` on the `ComplaintRelatedToMap` record whose `code` is not in scope. Do this through the MDMS update API or the configurator; do **not** edit the product seed file.
3. Confirm exactly one row remains `active: true` at the state tenant.
4. Verify in the citizen UI that the "Complaint related to" step no longer appears.

Re-running `ccrs-migrate` will **not** undo this: the default is strictly add-if-missing, and the deactivated row still exists so it is not re-created. Re-activation would require `--update-masters`, which must not be passed during a single-authority launch.

### Live cms-pilot observation (verified)

The cms-pilot environment carries **exactly one row**:

```
code = IGE ,  tenantCode = mz ,  active = true
```

Note the difference from the product seed:

| Source | `code` | `tenantCode` |
|---|---|---|
| Product seed (`docs/migration/seed/ComplaintRelatedToMap.json`) | `IGE` | `mz.ige` |
| Live cms-pilot | `IGE` | `mz` |

> **NOT VERIFIED — which mapping is intended.** The pilot maps `IGE → mz` while the product seed maps `IGE → mz.ige`. Both are recorded here deliberately. **Do not silently "correct" either one.** Before changing a live environment, establish which tenant actually holds that authority's complaint hierarchy, departments and employees — `tenantCode` is the tenant the citizen's complaint is dispatched into, and changing it after complaints exist splits the data across two tenants. Resolving this discrepancy is an open item for the environment owner, not a documentation change.

---

## 9. Environment variables and service properties

### 9.1 `pgr-services` — `backend/pgr-services/src/main/resources/application.properties`

Two Mozambique-relevant changes:

| Key | Value / behaviour | Class | Required |
|---|---|---|---|
| `allowed.source` | Extended from `whatsapp,web,mobile,RB Bot` to additionally allow `email,inperson,letter,linhaverde` | ENVIRONMENT (baked into the image) | **Yes** |
| `pgr.department.scope.roles` | Empty default. Role codes listed here are restricted to their own HRMS department on complaint search / count / plainSearch (`PGRConfiguration.java:195-199`, `EmployeeDepartmentScopeService`) | ENVIRONMENT | Optional |

`allowed.source` matters operationally: the Reception Officer's channel-of-receipt codes ride `service.source`, so a complaint created with `email` / `inperson` / `letter` / `linhaverde` **400s on an unpatched environment**. Pin a `pgr-services` image that carries the extended list (`host_vars` → `pgr_services_image` → `PGR_SERVICES_IMAGE` in `digit.env`).

`pgr.department.scope.roles` should be left **empty** until department code↔name matching is verified for the tenant's MDMS (`MDMSUtils.getDepartmentCodeToNameMap` caches per city tenant and only caches non-empty results). Empty preserves existing unrestricted behaviour on upgrade. Rollback = clear it and restart `pgr-services`.

Other relevant existing keys: `pgr.notification.config.driven`, `pgr.notification.default.locale`, `pgr.notification.mdms.cache.ttl.ms`, `pgr.escalation.*`, `pgr.visibility.*`, `pgr.dashboard.refresh.*`, `state.level.tenantid.length=1`.

### 9.2 `default-data-handler` — `utilities/default-data-handler/src/main/resources/application.properties`

| Key | Release value | Notes |
|---|---|---|
| `default.tenant.id` | `statea` | **Must be set to the real state root** before first boot |
| `default.localization.locale.list` | `en_IN,hi_IN,pt_PT` | `pt_PT` added by the Mozambique line |
| `default.localization.module.create.list` | see §6.2 | |
| `default.mdms.schema.create.list` | includes `commonMDMSConfig.PrivacyPolicy` | Corrected from `commonUiConfig.PrivacyPolicy` |
| `dev.enabled` | `true` | Loads `mdmsData-dev` + dev localization — the **only** place the complaint-hierarchy demo data, `Workflow.*`, `tenant.tenants` and the notification masters live |
| `default.mdms.data.path` | `classpath:mdmsData/**/*.json` | |
| `default.config.data.path` | `classpath:configData/**/*.json` | |
| `default.localization.data.path` | `classpath:localisations/*/*.json` | |
| `pgr.workflow.variant` | default `standard` (see §7.4) | `cms` selects `CmsPgrWorkflowConfig.json` |

DDH boot order (`StartupSchemaAndMasterDataInitializer`, once, ~10 s after start):

```
createMdmsSchemaFromFile → loadAllMdmsData(default) → loadAllConfigData(default)
  → upsertLocalizationFromFile(default) → [if dev.enabled] loadAllMdmsData(dev) + dev localization
```

DDH never deletes. Disabling `dev.enabled` stops dev-data seeding. **Re-running DDH can revert the `x-ref-schema` jsonb fix** — re-apply it (§7.1).

### 9.3 Tenancy pins — `digit.env` and compose

The JVM tier reads its state-level tenant's MDMS (`Workflow`, `DataSecurity`) **at startup**. Pointing it at a not-yet-bootstrapped tenant crash-loops the service. Hence the documented boot pattern:

| Variable (host_vars) | Meaning | Fresh-install value |
|---|---|---|
| `state_root` | State-tier `STATE_LEVEL_TENANT_ID` boot pin; also drives the encrypt-for-lookup key | Pre-seeded source tenant until bootstrap completes |
| `tenant_id` | City-tier `STATE_LEVEL` (workflow + enc-service) boot pin | Pre-seeded source city until bootstrap completes |
| `state_tenant_id` | MCP root target | `mz` |
| `city_tenant` | MCP city target | `mz.<city>` |
| `ui_state_tenant_id` | Tenant the SPA lands on | `mz.<city>` |

The playbook **defers** the `STATE_LEVEL_TENANT_ID` rewrite until after bootstrap (`playbook-deploy.yml:1406-1438`). Changing `state_root` later requires regenerating the enc-service keys for the new root (the playbook's "pre-bootstrap — generate enc-service key" tasks) **before** services are repointed. A wrong `state_root` silently breaks login on tenants with encrypted usernames.

`local-setup/docker-compose.egov-digit.yaml` hardcodes the stock seed tenant `pg` (`STATE_LEVEL_TENANT_ID: pg` / `PARENT_LEVEL_TENANT_ID: pg`) on `inbox` and other services; the Ansible playbook rewrites these literals to `{{ state_root }}` at deploy time (`playbook-deploy.yml:1416-1426`). The file contains no `mz` literal. This predates the Mozambique delta (unchanged from the upstream baseline) and is overridden per-tenant by `digit.env` on ansible boxes; whether the hardcode is intentional for all deployments is unestablished.

### 9.4 nginx vhost

| Feature | Detail | Class | Required |
|---|---|---|---|
| gzip scoped to `/digit-ui` | `gzip on` / `vary` / `min_length 1024` / `comp_level 5`; `gzip_types` css + js + json + svg. **Never applied to Kong/API routes.** | ENVIRONMENT | Strongly recommended |
| `Cache-Control: no-cache` on `/digit-ui` | The bundle filename is not content-hashed, so long caching is unsafe | ENVIRONMENT | Yes |
| `/digit-ui-test/` testing entrance | Renders only when `testing_ui_enabled: true`. Aliases the **same** build, htpasswd-gated, separate `globalConfigs.testing.js` (`CONTEXT_PATH=digit-ui-test`, `TESTING_MODE=true`, `LOGIN_TENANT_ALLOWLIST` = the testing tenant), red banner via `sub_filter` | ENVIRONMENT | Optional, off by default |

Applied in both `local-setup/nginx/digit-ui.conf` (container) and `local-setup/ansible/templates/nginx-site.conf.j2` (host). Documented at `local-setup/ansible/docs/testing-entrance.md`.

`ccrs-migrate --only gzip` runs with **no credentials**: it probes `/digit-ui/index.js` with `Accept-Encoding: gzip`, and when run on the serving box backs up the conf, inserts the block into the **serving** `/digit-ui` location (redirect stubs skipped), runs `nginx -t` with **automatic rollback** on failure, reloads, and re-probes.

The testing entrance additionally requires `digit_ui_mode: static` and a tenant flagged `isTestingTenant`, or it renders empty.

### 9.5 Secrets

`host_vars` carries `secrets_path: kv/digit/<tenant>` plus a `bootstrap_secrets` map that the playbook seeds into the secret store (writing only missing keys).

> **Every credential in the example inventory files, in `configData/TemplateBinding.json`, and the default `--user` / `--pass` / basic-auth client id in `docs/migration/ccrs-migrate.cjs` and `docs/migration/landing-config/seed-landing-config.sh` are example/test defaults that MUST be changed.** Replace all of them, store them in the secret store at `secrets_path`, and never commit them. Pass `--pass` or `--token` to `ccrs-migrate` explicitly rather than relying on its default.

---

## 10. Frontend `globalConfigs.js` — the deploy-time SPA contract

| | |
|---|---|
| **Rendered by** | Actor A from `local-setup/ansible/templates/globalConfigs.js.j2` + `host_vars` into `<digit_dir>/nginx/globalConfigs.js`, injected into `<head>` by nginx `sub_filter` |
| **Read by** | The SPA via `Digit.Utils.getConfig(<KEY>)` |
| **Class** | ENVIRONMENT |
| **Required** | Yes |
| **Change cost** | A **re-render**, not a rebuild — `./deploy.sh <tenant>` or `--tags nginx` |

Keys emitted by the template, verified at the release commit:

```
AUTH_PROVIDER  BOUNDARY_TYPE  CITIZEN_AUTH_PROVIDER  COMPLAINT_HIERARCHY_TYPE  CONTEXT_PATH
CORE_MOBILE_CONFIGS  CORE_POSTAL_CONFIGS  DASHBOARD_METRICS_ENABLED  DIGIT_FOOTER
DIGIT_FOOTER_BW  DIGIT_HOME_URL  EMPLOYEE_AUTH_PROVIDER  EMPLOYEE_MODULE_DENYLIST
ENABLE_SINGLEINSTANCE  FIN_ENV  GMAPS_API_KEY  HIERARCHY_TYPE  HRMS_CONTEXT_PATH
INVALIDROLES  JWT_TOKEN  KEYCLOAK_CLIENT_ID  KEYCLOAK_REALM  KEYCLOAK_URL
LOCALE_DEFAULT  LOCALE_REGION  LOGIN_TENANT_ALLOWLIST  MAP_CENTER  MAP_TENANT
MDMS_CONTEXT_PATH  MDMS_V1_CONTEXT_PATH  MDMS_V2_CONTEXT_PATH  PGR_BOUNDARY_HIGHEST_LEVEL
PGR_BOUNDARY_LOWEST_LEVEL  S3BUCKET  STATE_LEVEL_TENANT_ID  TESTING_MODE  TESTING_TENANT_ID
TOKEN_EXCHANGE_URL  UICONFIG_MODULENAME
```

`COMPLAINT_HIERARCHY_TYPE` and the two `TESTING_*` keys are Mozambique-line additions. `DASHBOARD_METRICS_ENABLED` is a deployed-box kill switch requiring no rebuild.

Mozambique-shaped values (from `local-setup/ansible/inventory/host_vars/maputo.yml.example`, verified):

| host_vars key | Example value |
|---|---|
| `state_tenant_id` | `mz` |
| `city_tenant` | `mz.maputo` |
| `ui_state_tenant_id` | `mz.maputo` |
| `login_tenant_allowlist` | `[ mz, mz.maputo ]` |
| `employee_module_denylist` | `[ IM ]` |
| `map_center` | `{ lat: -25.9692, lng: 32.5732 }` |
| `pgr_boundary_highest_level` | `Município` |
| `pgr_boundary_lowest_level` | `Bairro` |
| `boundary_type` | `Bairro` |
| `core_mobile_configs` | `{ countryCode: "+258", mobileNumberRegex: "^8[0-9]{8}$" }` |

`core_mobile_configs` uses **only** `countryCode` + `mobileNumberRegex`; length and allowed leading digits are derived from the regex by `local-setup/ansible/filter_plugins/mobile.py`. The playbook's preflight **rejects** the retired fields (`mobilePrefix`, `mobileNumberPattern`, `mobileNumberLength`, `mobileNumberAllowedStartingCharacters`, `mobileNumberErrorMessage`).

### 10.1 Locale defaults disagree between the product and ansible — verified

| Source | `LOCALE_REGION` | `LOCALE_DEFAULT` |
|---|---|---|
| `digit-ui-esbuild/public/globalConfigs.js:12-13` (product/dev build) | `"PT"` | `"pt"` |
| `local-setup/nginx/globalConfigs.js:12-13` (container default) | `"PT"` | `"pt"` |
| `local-setup/ansible/inventory/group_vars/digit.yml` | `IN` | `en` |
| `local-setup/ansible/inventory/host_vars/maputo.yml.example:51` | `"IN"` (deliberate) | — |

This is a **real, unresolved disagreement** about the product's default language. The local/dev build defaults to Portuguese; ansible-deployed boxes default to English unless `locale_region`/`locale_default` are overridden per host.

**Decide explicitly per environment.** Setting `locale_region: PT` / `locale_default: pt` requires the `pt_PT` packs to exist for **every** module the SPA loads. Today `pt_PT` covers only `rainmaker-common` and `rainmaker-pgr` (§6.1), so `rainmaker-hr` and `rainmaker-workbench` will render raw keys. The dashboard is covered: `enable-dashboard.sh` seeds a 322-message `rainmaker-dashboard` pack for both `en_IN` and `pt_PT`. Rollback is a host_vars edit plus a `globalConfigs` re-render.

---

## 11. Country and regional defaults that the seed gets wrong for Mozambique

Four items ship with non-Mozambique values (§§11.1–11.4) and must be corrected per environment; the remaining subsections are structural gaps in the same area; none is corrected automatically.

### 11.1 `common-masters.MobileNumberValidation` — **blocking**

Shipped seed (`mdmsData/common-masters/common-masters.MobileNumberValidation.json`), verified verbatim:

```json
[{ "countryCode": "+254", "mobileNumberRegex": "^0?[17][0-9]{8}$", "default": false }]
```

That is Kenya. Mozambique needs `+258` with `^8[0-9]{8}$`. A wrong value produces `INVALID_MOBILE_NUMBER` on **every** citizen and employee create.

The **only** automated route that writes the Mozambique value is the ansible `core_mobile_configs` path (§10) — a non-ansible install silently keeps the Kenyan rule. After changing this master, **flush the `validationRules` key in Redis**; `egov-user` pins the rule there and the old pattern keeps applying otherwise.

### 11.2 `common-masters.StateInfo.languages` — no `pt_PT`

See §6.4. Add the Portuguese entry by hand.

### 11.3 `dss.DashboardConfig` — Nairobi timezone and non-CMS roles

See §7.14. `timeZone` must be changed by hand; roles are remapped by `enable-dashboard.sh` via `ROLE_MAP` / `DASHBOARD_ALLOWED_ROLES`.

### 11.4 `core_postal_configs`

The fork-only `stateige.yml.example` still carries a Kenya postal pattern with an explicit "ADJUST for Mozambique" note. Set a real Mozambique pattern or leave the key unset.

### 11.5 MDMS has no schema-update API

Any additive schema property (for example `tenant.citymodule.bannerImage`) can only reach an **existing** environment via direct SQL plus an `egov-mdms-service` restart — `docs/migration/fix-citymodule.sh` is the reference pattern. This is a structural upgrade gap, not a one-off.

### 11.6 No Mozambique taxonomy data in the repository

The release contains **no** Mozambique `tenant.tenants`, boundary, `Department`, `Designation` or `ComplaintHierarchy` data. All of it is operator-supplied XLSX. **An engineer configuring a new environment from the repository alone cannot reproduce the taxonomy** — the spreadsheet dump is an out-of-band dependency that must be obtained separately.

### 11.7 `stateige.yml.example` header is stale (fork-only file)

`local-setup/ansible/inventory/host_vars/stateige.yml.example` — one of only two files in the fork-local delta — still carries the header and comment block of `bomet.yml.example` (Kenya), including "cp inventory/host_vars/bomet.yml.example …", "./deploy.sh bomet" and Bomet-specific deviation notes, while its body sets `state_root: mz` / `state_tenant_id: mz` / `tenant_id: mz` and `domain: localhost`. **Read the body, ignore the header.** Correcting it is a documentation fix for a later release.

---

## 12. `ccrs-migrate.cjs` — the unified entry point

`docs/migration/ccrs-migrate.cjs` is the single supported seeding runner: idempotent, continue-on-error, dry-runnable. Its exit code is the number of phases needing attention.

### Phases, in fixed order

```js
const ALL_PHASES = ['auth', 'schemas', 'hierarchy', 'pgr-masters', 'landing', 'cms', 'banner', 'gzip', 'verify'];
```

| Phase | Opt-in | Writes at | Covered in |
|---|---|---|---|
| `auth` | — | — | credentials / token |
| `schemas` | — | state | §7.1 |
| `hierarchy` | — | per tenant | §7.5 |
| `pgr-masters` | — | state | §7.6–7.8 |
| `landing` | — | state | §7.13 |
| `cms` | `--cms` | roles: state **+** city; actions/grants: state; workflow: city | §7.2–7.4 |
| `banner` | — | per tenant | §4.3 |
| `gzip` | `--gzip` | nginx conf on the serving box | §9.4 |
| `verify` | — | read-only | below |

### Invocation

```
node docs/migration/ccrs-migrate.cjs \
  --host <gateway-url> \
  --tenant <state-root>,<authority-1>,<authority-2> \
  [--user <admin-user>] [--pass <admin-password>] [--token <authToken>] \
  [--phases schemas,landing] [--only gzip] [--dry-run] [--cms] \
  [--update-masters] [--update-wf] [--locale en_IN] [--hierarchy PGR] \
  [--banner-url <banner-url>] [--gzip] [--nginx-conf <path>] [--nginx-container <name>] \
  [--report <out.json>]
```

- **Always run `--dry-run` first** — zero writes.
- `--tenant a,b,c` runs state-level phases once against the state root and repeats only the city-scoped `cms` phase per tenant.
- `--only <phases>` runs exactly those and implies their opt-in flags; `gzip` is auth-free, so `--only gzip` needs no credentials.
- Always safe to re-run: completed work is detected and skipped. Add `--update-masters` **only** when you intend to sync drifted rows.
- The runner **never deletes**. Hierarchy rollback is `pg_restore` (`operator-runbook.md` §6).
- Seed files are read from the checkout the script lives in — run it from the release checkout.

### `verify` phase — what it actually asserts

`phaseVerify` (`ccrs-migrate.cjs:1113-1129`) reads `ComplaintHierarchy`, `ComplaintRelatedToMap`, `ComplaintTemplateType`, `LandingSection`, `LandingPageConfig` and reports counts. Only **one** condition is asserted:

```
LandingSection >= 10  AND  LandingPageConfig >= 1     → OK, otherwise PARTIAL / VERIFY_LOW_COUNTS
```

Hierarchy and master counts are **reported, not asserted** — they depend on environment data. Do not treat a green `verify` as proof that the complaint taxonomy or the authority masters are correct.

### Companion scripts

| Script | Purpose |
|---|---|
| `docs/migration/install-schemas.cjs` | Schema registration standalone |
| `docs/migration/seed-pgr-masters.cjs` | PGR masters standalone |
| `docs/migration/preflight-dryrun.cjs` | Hierarchy cutover preflight |
| `docs/migration/landing-config/seed-landing-config.sh` | Landing config standalone |
| `docs/migration/fix-citymodule.sh` | SQL patch for `citymodule` schema drift |
| `docs/migration/enable-gzip.sh` | nginx gzip standalone |
| `local-setup/scripts/seed-notifications.py` | Notification masters (invoked by ansible) |
| `local-setup/scripts/enable-dashboard.sh` | DSS catalog installer |
| `docs/migration/operator-runbook.md` | Hierarchy cutover runbook |
| `docs/migration/README.md` | Phase reference table |

> **The MDMS seeding layer has no version table, no checksum and no applied-state record.** Idempotency is achieved by read-before-write, not by a migration ledger. There is no way to ask an environment "which seed version is applied?" — only to diff its records against the seed files.

---

## 13. Day-2 configuration surface (configurator)

`configurator/packages/data-provider/src/providers/resourceRegistry.ts` maps configurator screens to MDMS schemas — this is the intended day-2 path, changing configuration **without a deploy**:

Complaint Types (`ComplaintHierarchy`), `ComplaintHierarchyDefinition`, `LandingSection`, `LandingPageConfig`, `common-masters.StateInfo` (Branding), `tenant.citymodule`, `common-masters.IdFormat`, `Workflow.BusinessService` / `BusinessServiceConfig` / `AutoEscalation` / `AutoEscalationStatesToIgnore` / `BusinessServiceMasterConfig`, `common-masters.wfSlaConfig`, `ACCESSCONTROL-ROLEACTIONS` (Role Actions) and `ACCESSCONTROL-ACTIONS-TEST` (Action Mappings). **`ACCESSCONTROL-ROLES.roles` is NOT in the configurator registry** — role rows must be created via the MDMS API or `ccrs-migrate --only cms`, `DataSecurity.EncryptionPolicy` (write roles `MDMS_ADMIN` | `SUPERUSER`) / `DecryptionABAC` / `MaskingPatterns` / `SecurityPolicy`, `INBOX.InboxQueryConfiguration`, `egov-hrms.*`, `common-masters.CronJobAPIConfig`, `common-masters.uiHomePage`, `common-masters.ThemeConfig`, `common-masters.MobileNumberValidation`, `egov-location.TenantBoundary`, `RAINMAKER-PGR.UIConstants`, `RAINMAKER-PGR.MapConfig`, `RAINMAKER-PGR.Notification{Routing,Template,ProviderTemplate}`, plus the tenant "Make this a testing tenant" toggle.

Enable with `nginx_features.configurator: true` and let the playbook's "Configurator UI localization seed" task run.

> `writeRoles` in the resource registry is a **UX gate only**. Server-side authority remains the role-action mapping (§7.3).

---

## 14. Verification checklist

Run after seeding, before declaring an environment ready.

| # | Check | How |
|---|---|---|
| 1 | Tenant records exist | MDMS search `tenant.tenants` at the **root** (not the city) |
| 2 | Boundary hierarchy valid | `validate_boundary_hierarchy` at the **city** — valid / owner_matches / order_matches |
| 3 | Schemas registered | MDMS search returns all 12 `RAINMAKER-PGR.*` + 2 landing + `tenant.*` + `commonMDMSConfig.PrivacyPolicy` |
| 4 | Landing seeded | `ccrs-migrate --phases verify` → `LandingSection ≥ 10`, `LandingPageConfig ≥ 1` |
| 5 | Authority masters | `ComplaintRelatedToMap`, `ComplaintTemplateType`, `ComplaintExtendedAttributeSchema` present at the state; `x-no-mask` present on both schema refs |
| 6 | **Single-authority narrowing** | Exactly one `active: true` row in `ComplaintRelatedToMap`; authority picker hidden in the citizen wizard (§8) |
| 7 | Roles | All 7 `CMS_*` roles **plus** `CONFIDENTIAL_COMPLAINT_VIEWER` (8 rows) present at state **and** city — 5 `CMS_*` auto-registered by `--cms`, the other 3 (`CMS_ADMIN`, `CMS_DASHBOARD_VIEWER`, `CONFIDENTIAL_COMPLAINT_VIEWER`) added manually (§7.2) |
| 8 | Grants | 243 CMS-related grants present, not 181 (§7.3) |
| 9 | Workflow | `PGR` BusinessService present at the city with the CMS state machine; `egov-workflow-v2` restarted after creation |
| 10 | Mobile validation | `common-masters.MobileNumberValidation` = `+258` / `^8[0-9]{8}$`; Redis `validationRules` flushed; a test citizen create succeeds |
| 11 | Languages | `pt_PT` present in `StateInfo.languages`; Portuguese selectable and rendering (not raw keys) |
| 12 | Localization cache | Redis computed-message caches flushed after the last upsert; SPA hard-refreshed |
| 13 | Complaint sources | A complaint created with `source = inperson` (or `letter` / `email` / `linhaverde`) succeeds — proves the `allowed.source` image pin (§9.1) |
| 14 | Employees | Employees exist at the **city**, searchable by mobile, holding the expected CMS roles; re-login performed after role assignment |
| 15 | Dashboard (if enabled) | Card visible for a role in `allowedRoles`; `timeZone` = the Mozambique zone; OAuth token store flushed |
| 16 | gzip | `/digit-ui/index.js` served with `Content-Encoding: gzip`; API routes **not** gzipped |
| 17 | Admin search exposure | Confirm who can reach `POST /pgr-services/v2/request/_admin/_search`; treat it as **unauthorized-by-default** (§7.3) until the server-side gate ships |

---

## 15. Configuration limitations in this release

Carried here in full because they change what an operator must do by hand.

1. **Admin-search endpoint has no server-side authorization gate.** Client-side only. Proven bypassable on cms-pilot. Not fixed in this documentation-only release. (§7.3)
2. **Only 5 of the 8 CMS-related roles in the seed are auto-registered** (5 of the 7 `CMS_*`; `CONFIDENTIAL_COMPLAINT_VIEWER` is not a `CMS_*` code and is also unregistered); `CMS_ADMIN`, `CMS_DASHBOARD_VIEWER` and `CONFIDENTIAL_COMPLAINT_VIEWER`, plus their 62 grants, require manual registration. (§7.2, §7.3)
3. **Deploy-time CMS seeding is not in this release** — `node docs/migration/ccrs-migrate.cjs --only cms` is a **manual post-deploy step**. (§2, §3)
4. **CCSD-2171 geography drill-down is not in this release** — no `boundaryPath` subtree parameter, no dashboard geography filter.
5. **`PGR_WORKFLOW_VARIANT` is not set anywhere** after `default-data-handler` left the compose stack. Marked **NEEDS VERIFICATION**. (§7.4)
6. **`stateige.yml.example` carries a stale Kenya header** and `domain: localhost`. (§11.7)
7. **`develop` has diverged from `master`** (2 ahead / 1 behind) but the **trees are identical** — pure history duplication of `stateige.yml.example`. Technical debt, not a release blocker.
8. **No down-migrations or undo scripts exist anywhere.** Configuration rollback = restore the database from a dump, or re-post the previous record. The MDMS seeding layer has no version table, checksum or applied-state.
9. **A newly created workflow BusinessService requires an `egov-workflow-v2` restart.**
10. **Two Flyway migrations end with a non-concurrent `REFRESH MATERIALIZED VIEW`** whose duration on production data is unmeasured. (Database-side; noted here because it affects deploy windows.)
11. **Zero Mozambique-specific database migrations exist** — all 22 Flyway migrations are byte-identical to upstream. No Moz-specific migration blocks a fresh install, an upgrade, or an image rollback.
12. **No automated test coverage** exists for workflow transitions, notifications, extended attributes, roles/permissions or localization — the configuration surface described in this document is validated **manually only** (checklist §14).

---

## 16. Path index

**Product configuration (do not edit per environment)**
```
utilities/default-data-handler/src/main/resources/
  application.properties
  CmsPgrWorkflowConfig.json            PgrWorkflowConfig.json
  schema/RAINMAKER-PGR.json            schema/rainmaker-pgr-landing.json
  schema/tenant.json                   schema/commonMDMSConfig.json
  schema/IgeComplaintExtendedAttributes.json
  schema/IgsaeComplaintExtendedAttributes.json
  mdmsData/ACCESSCONTROL-ROLE/ACCESSCONTROL-ROLES.roles.json
  mdmsData/ACCESSCONTROL-ROLEACTIONS/ACCESSCONTROL-ROLEACTIONS.roleactions.json
  mdmsData/ACCESSCONTROL-ACTIONS-TEST/ACCESSCONTROL-ACTIONS-TEST.actions-test.json
  mdmsData/RAINMAKER-PGR/RAINMAKER-PGR.LandingSection.json
  mdmsData/RAINMAKER-PGR/RAINMAKER-PGR.LandingPageConfig.json
  mdmsData/commonMDMSConfig/commonMDMSConfig.PrivacyPolicy.json
  mdmsData/tenant/tenant.citymodule.json
  mdmsData/common-masters/common-masters.StateInfo.json
  mdmsData/common-masters/common-masters.MobileNumberValidation.json
  mdmsData/egov-bndry-mgmnt/CMS-BOUNDARY.HierarchySchema.json
  mdmsData/DataSecurity/{EncryptionPolicy,DecryptionABAC,MaskingPatterns,SecurityPolicy}.json
  mdmsData-dev/RAINMAKER-PGR/RAINMAKER-PGR.Notification{Routing,Template,ProviderTemplate}.json
  configData/{NotificationChannel,ProviderDetails,TemplateBinding}.json
  localisations/{default,en_IN,pt_PT}/*.json
docs/migration/seed/{ComplaintRelatedToMap,ComplaintTemplateType,ComplaintExtendedAttributeSchema}.json
backend/pgr-services/src/main/resources/application.properties
```

**Environment configuration (edit per box)**
```
local-setup/ansible/inventory/host_vars/<tenant>.yml     (from _example.yml / maputo.yml.example)
local-setup/ansible/inventory/group_vars/digit.yml
local-setup/ansible/templates/globalConfigs.js.j2
local-setup/ansible/templates/nginx-site.conf.j2
local-setup/nginx/digit-ui.conf                          local-setup/nginx/globalConfigs.js
local-setup/docker-compose.egov-digit.yaml               (+ migrations / monitoring / fast-path overlays)
ansible/nairobi-mdms/mdms/dss/{KpiDefinition,DashboardPack,DashboardConfig}.json
```

**Tooling and runbooks**
```
docs/migration/ccrs-migrate.cjs          docs/migration/README.md
docs/migration/operator-runbook.md       docs/migration/preflight-dryrun.cjs
docs/migration/install-schemas.cjs       docs/migration/seed-pgr-masters.cjs
docs/migration/fix-citymodule.sh         docs/migration/enable-gzip.sh
docs/migration/landing-config/seed-landing-config.sh
local-setup/scripts/enable-dashboard.sh  local-setup/scripts/seed-notifications.py
local-setup/ansible/deploy.sh            local-setup/ansible/playbook-deploy.yml
local-setup/ansible/docs/testing-entrance.md
digit-mcp/src/tools/mdms-tenant.ts
configurator/packages/data-provider/src/providers/resourceRegistry.ts
```

**Known-stale — do not follow**
```
docs/agency-category-tenant-mapping.md   (documents RAINMAKER-PGR.AuthorityConfig, which does not exist)
```