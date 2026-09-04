# CMS-MOZ-V2.12 — Initial Release Preview (Revision 4)

> **Revision 4 (2026-09-04):** release version corrected to **V2.12** (was mistyped 12.2); tag string is now `CMS-MOZ-V2.12`; files renamed accordingly.

> **Revision 3 (2026-09-04):** 13 corrections from the independent fact-check applied — §A2 Helm-path nuance, §A3 six password literals (was 1), test coverage 19 files (was ~3), subtree debt 41 files (was 25), corrected hashes/counts/Jira figures/role list. Post-correction confidence: ~90%.

**Prepared:** 2026-09-04 · **Status: PREVIEW ONLY — no tag created, nothing pushed, no repository modified.**
**Audited refs:** `eGov-Global/CMS-MOZAMBIQUE` `origin/master` @ `57e28906` (2026-09-03) vs upstream DIGIT product baseline `815b2374` (last shared upstream commit, 2026-08-13).

---

## Revision 2 — reviewer decisions applied

| # | Reviewer decision | Applied |
|---|---|---|
| 1 | Remove the admin-search endpoint item | Removed from Release Gaps / risks / readiness blockers |
| 2 | Remove the Gate 2 Release Checklist section | Section removed |
| 3 | IGE/IGSAE product decision | Recorded: the product **keeps both-authority functionality**; IGSAE is switched off for this deployment via MDMS (`active: false`), not removed from the product |
| 4 | Tag name spaces | Tag is now **`CMS-MOZ-V2.12`** throughout |
| 5 | Hygiene before tagging | Reduced to: tag targets `origin/master` @ `57e28906`; include necessary commits only; local/unpushed commits and the "possibly unrelated" list are ignored for the tag |

Also added in this revision: **Section A — Implementation observations (Ozeki SMS / OTP / passwords)**, saved for review as requested, each item verified against the repository.

---

# Section A — Implementation observations (not yet raised as Git issues)

*Source: implementation/testing findings from the Mozambique environment (Ozeki SMS provider integration). Saved here for product review. Each item was checked against `origin/master` to establish whether a fix already exists in the repo.*

## A1. `enable_otp_services=true` does not switch OTP to the real services

**Observation:** setting `enable_otp_services: true` (host_vars), removing the `plugins:` request-termination mock, enabling the OTP profile (`egov-otp`, `user-otp`, `egov-notification-sms`) and reviewing the SMS gateway config — OTP generation/validation is **still routed through `user-otp-mock` and `otp-validate-mock`**.

**Repo verification (confirmed — this is a real product gap):**
- `enable_otp_services` exists in all host_vars examples (default `false`) and does exactly two things: adds the `otp` compose profile (`playbook-deploy.yml:1497`) and sets `GATUS_PROFILE_OTP` (`templates/digit.env.j2:114`). **It never touches Kong.**
- `local-setup/kong/kong.yml` is **static** (not templated by Ansible). The mock services `user-otp-mock` (kong.yml:325, `request-termination` short-circuits every `/user-otp/*` call with a canned success, fixed OTP 123456) and `otp-validate-mock` (kong.yml:856) are **always present regardless of the flag**. De-mocking is a manual kong.yml edit on the box, and the comment at kong.yml:853 documents exactly that manual step.
- **Conclusion:** the flag starts the real services but never re-routes traffic to them. Fix needed in product: make the Kong mock blocks conditional on `enable_otp_services` (template kong.yml, or have the playbook patch/remove the `request-termination` plugin when the flag is true).
- **Status: NOT fixed in the repository.**

## A2. Second OTP validation fails for new-citizen registration

**Observation:** OTP is stored in Redis (not the `eg_token` table), removed from Redis on first successful validation; the registration flow then triggers a **second** validation against the already-consumed OTP → citizen gets "invalid OTP".

Flow observed:
```
mobile → validate → OTP sent → stored in Redis → citizen validates (OTP deleted)
→ new citizen? → create user → second OTP validation → FAILS (OTP gone)
```

**Fix applied on the environment (user-service config):**
```
CITIZEN_REGISTRATION_WITHLOGIN_ENABLED=true
OTP_VALIDATION_REGISTER_MANDATORY=false
```
Result: citizen is created active after the first successful validation; no second OTP round.

**Repo verification (corrected in revision 3):**
- The two parameters DO exist in the repo — but only on the **Helm/k8s path**: `devops/deploy-as-code/charts/core-services/egov-user/values.yaml:140` (`OTP_VALIDATION_REGISTER_MANDATORY`) and `:172` (`CITIZEN_REGISTRATION_WITHLOGIN_ENABLED`), already wired as conditional values (also in `egov-user-enc-values.yaml`).
- They appear **nowhere on the ansible/compose path** (`local-setup/`) — which is how the Mozambique servers deploy. So a redeploy of the Mozambique environment from the repo **reproduces the bug**; the fix is environment-only for this deployment path. Product action: mirror the two values into the compose/ansible egov-user configuration (the Helm templating shows the pattern to copy).
- Related prior work: the same double-consume root cause was diagnosed earlier and a code-level fix exists on the local branch `fix/otp-register-double-consume` (commit `d069ae3d`) — **never pushed, no PR**. Product should decide between (a) committing the two env parameters into the deployment templates, (b) landing the code fix, or (c) both.
- Redis-vs-`eg_token` storage and the missing tracer logic live inside the platform `egov-otp`/`user-otp` images — **not verifiable from this repository** (upstream platform behaviour, product-side item).
- **Status: NOT fixed in the repository; fix exists only on the live environment (+ one unpushed local branch).**

## A3. Deployment breaks when default passwords are changed

**Observation:** changing the bootstrap secrets (`postgres_password`, `mcp_db_password`, `minio_root_user/password` from `change-me-strong`/`minioadmin`) causes deployment failure — scripts internally expect `eGov@123` in a few places.

**Repo verification (confirmed — SIX true hardcodes, corrected in revision 3):**
- **Six literal `eGov@123` occurrences** in `local-setup/ansible/playbook-deploy.yml` with no variable at all: line **4400** (`--env-var "password=eGov@123"`), lines **4440, 4471, 4611, 4707** (`DIGIT_PASSWORD=eGov@123`) and **4709** (`DIGIT_EMPLOYEE_PASSWORD=eGov@123`). Fixing only one still breaks a changed-password deploy at the next.
- 9 further locations use `{{ bootstrap_password | default('eGov@123') }}` (lines 1733, 2382, 3180, 3285, 3309, 3561, 3716, 4091) and `{{ notif_seed_pass | default('eGov@123') }}` (4359). Override-able only if the operator sets the same variable everywhere; the mixed literal/variable usage is what makes a password change break mid-deploy.
- `change-me-strong` / `minioadmin` appear only in the host_vars example files (placeholders, expected) — the failure is on the consumer side in the playbook, not the examples.
- **Recommended product action:** replace **all six** literals with the variable; sweep the playbook so every credential reference goes through exactly one variable; then re-test a full deploy with non-default secrets.
- **Status: NOT fixed in the repository.**

---

# Section B — Release Preview

## 1. Executive Summary

CMS Mozambique ("Fala Cidadão") is the Mozambique implementation of the DIGIT Complaint Management System, built for the IGE authority (with IGSAE supported by the product and currently disabled by configuration — see §16, decision D-1). Compared to the standard DIGIT product it adds: a public Portuguese landing website, a rebuilt citizen complaint form with per-authority dynamic questions, a multi-tier officer workflow (Reception → Screening → Supervisor → Case Manager), department/jurisdiction visibility rules, an admin cross-department search screen, confidential-complaint handling, Portuguese localization throughout, SMS via the Ozeki gateway (with a mode that works without the Novu stack), a configurable analytics system (off by default), a visual landing-page builder in the admin console, and extensive operator tooling.

**Scale:** 658 commits (403 non-merge; ~358 distinct after removing cherry-pick twins), 343 files, +44,876 / −3,117 lines, 2026-06-12 → 2026-09-03.

**Main open items:** the three implementation observations in Section A (OTP enablement, second-OTP registration failure, hardcoded passwords — none fixed on the Mozambique deploy path yet), thin automated test coverage (19 test files touched; concentrated in analytics/scoping/notifications, absent for workflow/localization/roles), and a customization document that covers only the backend.

## 2. Release Scope

| Fact | Value |
|---|---|
| Proposed tag | **`CMS-MOZ-V2.12`** |
| Release ref | `origin/master` @ `57e28906` (2026-09-03) — necessary commits only; local/unpushed commits are not part of the tag |
| Product baseline | `egovernments/Citizen-Complaint-Resolution-System` @ `815b2374` |
| Comparison basis | Full tree diff product → Mozambique (initial official release; not v1.0.0-relative) |
| Delta | 658 commits · 343 files · +44,876 / −3,117 |
| Areas | digit-ui 139 files · configurator 61 · backend 40 · docs 32 · local-setup 27 · utilities 25 · CI 15 · tests 2 |
| Database migrations added by Mozambique | **0** (all Flyway migrations identical to upstream) |
| Prior tag `cms-mozambique-v1.0.0` | Exists on a side branch; used as evidence only, not baseline |

## 3. Major Mozambique Customizations

1. **Public "Fala Cidadão" landing site** — public homepage + privacy-policy + tutorial pages, Portuguese-first, MDMS-configurable, visually editable from the admin console (`ccd8b576`, `0737156a`, `0dce489b`, `cec2b6fe`)
2. **CMS multi-tier workflow** — 4-role officer chain; employee action screens build themselves from the workflow definition (`772a5986`, `bffdce15`)
3. **Visibility scoping** — department and/or geographic jurisdiction (incl. boundary subtrees); reception staff see the complaints they filed (`fe7cab60`, `9e650397`, `79dae4ef`, `74eac21c`)
4. **Admin cross-department search** — one screen (SUPERUSER/CMS_ADMIN) with filters, Excel export, dedicated endpoint (`dae9ec08`, `8da74a9e`)
5. **Confidential complaints** — complainant identity masked; selected fields stay visible via MDMS `x-no-mask` (`992735af`, `8746bcab`)
6. **Rebuilt citizen complaint form** — 3-step wizard, authority picker, dynamic fields from MDMS JSON-Schema, N-level categories, drafts, consent (`81054330`, `be6c9eaa`)
7. **Portuguese product** — pt_PT default, full packs seeded, city-level wording overlays, Fala Cidadão branding, MDMS-driven theme colours (`21a6f1f2`, `f42ad659`, `954e134d`, `9597f0ab`)
8. **Notifications** — Ozeki SMS, direct-delivery without Novu, OTP pipeline, deep-link placeholders (`a95f8df2`, `91aded4c`, `a3be88e5`, `15ec1db5`)
9. **Analytics, off by default** — MDMS-configurable destinations with safety rails; one-command self-hosted Matomo (`e9a0f0e4`, `1fd0711e`, `1abef50f`)
10. **Operator tooling** — `ccrs-migrate.cjs`, escalation enablement, testing entrance, CI security scanning (`16b91133`, `718d65b1`, `06ee871e`, `bc0ecdac`)

## 4. Backend Changes

All 13 documented pgr-services items and 3 novu-bridge items in `docs/mozambique-customizations.md` are verified in code:

| Change | Meaning | Commit |
|---|---|---|
| Department-scoped search | Configured roles see only their department | `fe7cab60` |
| Jurisdiction-scoped search | Configured roles see only their area | `9e650397` |
| Admin cross-department search API | New `POST /v2/request/_admin/_search` | `dae9ec08` |
| `createdBy` search filter | "Complaints I filed" for reception staff | `1f9b68a2` |
| Selective confidential-field visibility | `x-no-mask` keeps chosen fields readable | `8746bcab` |
| Configurable escalation states | Which statuses the escalation job scans | `718d65b1` |
| New intake channels | email / in-person / letter / Linha Verde | `b2272873` |
| Notification recipient fix | Newest workflow step, not first match | `f05c52d5` |
| Terminal transition fix | Assignee no longer breaks closing transitions | `f05c52d5` |
| Department display in notifications | 3-tier fallback, no more errors | `4fa8964c` |
| Acting-employee placeholders | Templates can name who acted | `4fa8964c` |
| Sort by last-modified | New search sort option | `1f9b68a2` |
| Scope-bypass hardening | Internal scoping flags blocked from the API | `9e650397` |
| novu-bridge: direct delivery (SMS/Email without Novu) | Resource-constrained servers | `91aded4c` |
| novu-bridge: Ozeki SMS provider | Complaint + OTP SMS via Ozeki | `a95f8df2`, `a3be88e5` |
| novu-bridge: OTP pipeline | Login codes delivered pre-account | `a3be88e5` |

**Backend changes NOT yet in the document** (see §15): jurisdiction scope widened to boundary **subtrees** (`79dae4ef` — the doc's "exact match" wording is stale), `{website}`/`{rate_link}`/`{reopen_link}` placeholders (`15ec1db5`), OTP expiry message 10→5 min (`0ac4b3f0` — message text only; whether real expiry matches is **not verified**), client-facing `department` search field (`4a6537c3`).

**Corrections to common assumptions:** the analytics/KPI dashboard engine (`org.egov.pgr.analytics`, 32 files) is upstream product code, not Mozambique work. There are zero Mozambique database migrations.

## 5. Frontend Changes

Largest area (139 files, +12,782/−1,292); 21 verified feature areas:

| # | Feature | Type | Key commits |
|---|---|---|---|
| 1 | Public landing site + privacy + tutorial (34 new files) | NEW | `ccd8b576`, `0dce489b`, `cec2b6fe` |
| 2 | Analytics shim (default-off, PII-scrubbed, 786 test lines) | NEW | `e9a0f0e4`, `4a2e8117` |
| 3 | Admin cross-department search screen + Excel export | NEW | `a0e18a4b`, `8da74a9e`, `ec222582` |
| 4 | Workflow-driven employee action modals (CMS tiers) | MODIFIED | `772a5986`, `aa500b8d` |
| 5 | History-derived routing (reopen→Supervisor, rate→Case Manager) | NEW | `adbf2da4`, `4d268d8f` |
| 6 | Reception-officer inbox scoping + "only my complaints" | NEW | `74eac21c`, `46d9081d` |
| 7 | Confidential-complaint masking (details + timeline) | NEW | `992735af`, `c0c6f30b` |
| 8 | Attachments: shared uploader, video/audio playback, per-step timeline evidence | NEW/FIX | `6bf0084a`, `e81431c2`, `721e44c8` |
| 9 | Citizen create wizard rebuild (3 steps, hierarchy, dynamic fields, drafts) | MODIFIED | `81054330`, `be6c9eaa` |
| 10 | Reopen/rating overhaul (merge-not-replace fix; 72h window; mandatory reason) | FIX | `92eaec23`, `2debbcfc`, `8597982d` |
| 11 | Localization mechanics: city overlay, honoured default locale, raw-key guards | MODIFIED | `3289ac3f`, `812b36b8` |
| 12 | Branding: name/emblem/favicon; MDMS ThemeConfig colours | MODIFIED | `954e134d`, `11c372d8` |
| 13 | Maps: authority-tenant boundaries, geocode loop guard, XSS-escaped tooltips | FIX | `62335750`, `60c5198c`, `8c1120f9` |
| 14 | Boundary cascade + readable address; postal code retired | FIX | `da545a8a`, `4aa5aa3b` |
| 15 | Channel-of-receipt chips on employee create | NEW | `6de45287` |
| 16 | Dashboard: breadcrumb + gutter when embedded | FIX | `aeea2cd4` |
| 17 | Testing-tenant scoping (`isTestingTenant` → `/digit-ui-test`) | NEW | `d83aa600`, `7423ae44` |
| 18 | Citizen navigation: single-module sidebar, avatar, logout destination | MODIFIED | `7a1afeeb`, `295b0756` |
| 19 | Error screens: own button key, image fallback, layout | FIX | `20ef8760`, `01446716` |
| 20 | Login/OTP: 120s resend with m:ss countdown, countryCode, tenant scoping | MODIFIED | `8fda161f`, `04ba4806`, `78ccee51` |
| 21 | Performance: cache-key fix, IndexedDB MDMS persistence, assignee-list caching | FIX | `ba8a7c27`, `5a096d23` |

⚠️ **41 files under `packages/**` (upstream subtree: 39 modified + 2 added) will conflict on future upstream syncs.** Highest-risk: `Localization/service.js`, `Store/service.js`, `libraries/utils/index.js`. One (the `video::-webkit-media-controls-panel` CSS deletion, `230cf374`) is a genuine upstream bug fix worth contributing back.

## 6. Workflow Changes

- New CMS multi-tier workflow (`CmsPgrWorkflowConfig.json`, 11 states / 18 actions), selected per deployment by `pgr.workflow.variant` (default `standard`) (`bffdce15`, `d37299b4`). Which value production uses is not verified from the repository.
- Escalation: configurable scan states (`718d65b1`); `enable-escalation.sh` (6 idempotent steps) + `docs/pgr-escalation/RUNBOOK.md`. No escalation UI exists — backend + bookkeeping only; reopen resets the escalation clock (`92eaec23`).
- Terminal transitions accept an assignee where the engine allows (`f05c52d5`); RATE-with-assignee still rejected by the engine — FE retries without it (`43d4c8ac`); accepted product decision recorded (`aafa912b`).
- Attachments per action: allowed everywhere, mandatory only where the state demands, AWAITINGINFORMATION exempt (`6bf0084a`, `7dfa7eb8`).

## 7. Configuration / MDMS Changes

- **New masters:** `ComplaintRelatedToMap`, `ComplaintTemplateType`, `ComplaintExtendedAttributeSchema` (+ IGE/IGSAE schemas with `x-security`/`x-no-mask`), `LandingSection` + `LandingPageConfig`, `common-masters.AnalyticsProvider`, `commonMDMSConfig.PrivacyPolicy` (module corrected, `c3e42214`), `tenant.citymodule.bannerImage` (`00ffd59f`), `FormValidations` registration (`cdc20c29`).
- **Backend config keys (all opt-in, off/empty defaults — verified):** `pgr.department.scope.roles`, `pgr.jurisdiction.scope.roles`, `pgr.escalation.states`, extended `allowed.source`, `egov.boundary.relationship.search.url`, `pgr.jurisdiction.subtree.cache.ttl.ms`, `novu.bridge.*` (6), `egov.ui.app.host.map`.
- **Configurator:** Landing Page Builder (`c2803e7f`); Analytics Providers editor + telemetry kill switch (`1fd0711e`); fail-closed write-role gating on sensitive masters (`a82a9508`); role-actions create/edit (`31048d69`, `6135b38f`); testing-tenant checkbox with guard rails (`0cfebb60`); environment default locale (`833f759d`); immediate localization propagation (`3d6fc082`); JSON/object-table widgets + 7 schema descriptors.
- **Operator tooling:** `ccrs-migrate.cjs` (idempotent, continue-on-error; schemas/hierarchy/localization/CMS/banner/gzip/Matomo phases); `fix-citymodule.sh`; `stateige.yml.example`; Matomo compose profile (localhost-bound); testing entrance (default OFF).
- **Deployment ordering note:** `f4d37bbd` + `6e72eed5` retire default-data-handler from compose and move seeds to `local-setup/db/full-dump.sql`; environments provisioned from older DDH images need the migration runner to pick up the analytics schema and CMS grants.

## 8. Localization Changes

- pt_PT first-class: seeded per tenant (`f42ad659`), default for mz (`21a6f1f2`), honoured on first load (`812b36b8`), Configurator included (`833f759d`).
- City-tenant overlay so city wording loads and wins (`3289ac3f`, `e33e801d`).
- "Fala Cidadão" rebrand (`9597f0ab`); Portuguese sidebar/login/OTP/rating/privacy content seeded.
- Raw-key/double-translation fixes (`0466b6d9`, `dd746026`, `dac66d9e`).
- ⚠️ pt_PT seed JSON was corrupted once and repaired (`34f87acc`) — re-validate all bundles parse before tagging.

## 9. Roles & Permissions

- 13 new roles seeded (`e79f0847`, `8e8c16dd`, `bffdce15`): CMS_RECEPTION_OFFICER, CMS_SUPERVISOR, CMS_CASE_MANAGER, CMS_VIEWER, CMS_ADMIN, CMS_DASHBOARD_VIEWER, DGRO; CENTRAL_USER, DEPARTMENT_USER; COMPLAINTS_VIEWER/EDITOR/CREATOR, CONFIDENTIAL_COMPLAINT_VIEWER. (~2,183 lines of grants. `CMS_SCREENING_OFFICER` pre-dates the baseline — upstream, not new.)
- Review flags: CMS_VIEWER is viewer-named but holds 37 write-capable grants; DGRO appears grant-less (intent not stated in commits); CENTRAL_USER (cross-tenant read) and CONFIDENTIAL_COMPLAINT_VIEWER (unmasked PII) are high-privilege and seeded by default.
- Registration gap (verified): `ccrs-migrate --cms` registers only 5 of 8 roles — CMS_ADMIN, CMS_DASHBOARD_VIEWER, CONFIDENTIAL_COMPLAINT_VIEWER need a manual post-deploy step.
- Configurator write-gating is UX-only by design; server-side ACCESSCONTROL remains the authority. The role-actions editor has no write-role gate — confirm the backend grant is admin-restricted.

## 10. Integrations

| Integration | Purpose | Status |
|---|---|---|
| Ozeki SMS gateway | Complaint + OTP SMS (via Novu, or direct HTTP) | NEW (`a95f8df2`, `91aded4c`) — disabled by default. See Section A for open enablement issues |
| SMTP direct email | Email without the Novu stack | NEW (`91aded4c`) — disabled by default |
| Novu / Twilio WhatsApp | WhatsApp stays on Novu | Upstream, unchanged |
| Matomo (self-hosted) | Analytics; one-command provisioning | NEW (`1abef50f`) — opt-in |
| PostHog / GA4 / Sentry / custom | Analytics adapters via MDMS | NEW (`e9a0f0e4`) — off by default |
| Nominatim / CARTO / OpenFreeMap | Geocoding + tiles | Upstream, tuned |
| youtube-nocookie | Tutorial video | NEW (`cec2b6fe`) |
| Gemini (CI only) | Security-finding triage | NEW (`e87007b1`) — not product code |

⚠️ Data-residency decision needed: the Configurator ships hardcoded PostHog + Sentry keys with `sendDefaultPii: true`; the kill switch fails open. Consider building with `VITE_CFG_TELEMETRY_KILL=true`.

## 11. Fixes and Improvements

Reopen/rate data loss (department wiped — `92eaec23`, `2debbcfc`); complaint-details crash (`12d0a960`); employee-create crash (`57d6b242`); map ward-tooltip XSS (`8c1120f9`); reverse-geocode infinite loop (`60c5198c`); videos as broken images (`e81431c2`) and fullscreen controls broken by vendored CSS (`230cf374`); storage-quota fix via IndexedDB; boundary cascade first-render (`4e2dbb5a`); login double-translation (`0466b6d9`); Configurator localization staleness (`3d6fc082`); notification recipient/department fixes (`f05c52d5`, `4fa8964c`); upstream-merge compile break repaired (`d983f318`); gzip + no-cache for the UI bundle (`874ec205`); postal-code input retired with its tests (`4aa5aa3b`).

## 12. Complete Commit Summary

658 commits = 255 merges + 403 non-merge; ~45 cherry-pick twins → **~358 distinct changes**. ~189 non-merge commits mention Jira keys — **78 unique, CCSD-1914 → CCSD-2207** (mechanical count over subjects+bodies). Security-scanning and analytics use GitHub PR numbers (#13–#58) instead.

| Category | Commits | Headline hashes |
|---|---|---|
| Frontend UX — Citizen (incl. landing, login/OTP) | 57 | `81054330`, `ccd8b576`, `e69c5029` |
| Complaint Workflow (CMS tiers, reopen, rate, confidentiality, ext. attrs) | 52 | `772a5986`, `bffdce15`, `92eaec23` |
| Search & Scoping (dept/jurisdiction/admin/createdBy) | 48 | `fe7cab60`, `9e650397`, `dae9ec08`, `74eac21c` |
| Frontend UX — Employee | 41 | `eca8d109`, `b2272873`, `468bf656` |
| Onboarding / Migration tooling | 30 | `16b91133`, `852ab0a9`, `124678e5` |
| Localization (pt_PT) | 28 | `f42ad659`, `3289ac3f`, `34f87acc` |
| Maps / Geolocation / Boundary | 22 | `62335750`, `60c5198c`, `4aa5aa3b` |
| Dashboard & Analytics (incl. Matomo stack) | 21 | `e9a0f0e4`, `1abef50f`, `aeea2cd4` |
| Configurator (Builder, testing tenant) | 20 | `c2803e7f`, `0cfebb60`, `3d6fc082` |
| CI / Security scanning | 19 | `bc0ecdac`, `844edab5`, `57e28906` |
| Documentation | 17 | `ab8c3a2c`, `48e4bc08`, `938623bd` |
| Deployment / Ops / perf | 15 | `874ec205`, `6e72eed5`, `b0d99e14` |
| Notifications (novu-bridge, Ozeki, OTP) | 7 | `a3be88e5`, `a95f8df2`, `91aded4c` |
| Branding / Theming | 4 | `954e134d`, `9597f0ab` |
| Tests / Revert | 2 | `ac4ce48a`, `ef956145` |
| Uncategorized / spanning areas | 20 | (commits whose primary area is ambiguous; counted once above where assigned) |

**Include/exclude candidates** (per reviewer decision #5, listed for the record only — the tag targets `origin/master` as-is): the `.github/` security-scanning subsystem (~19 commits, CI-only); `deploy-pilot-fe.sh` chain (6 commits, one pilot box); CODEOWNERS (`41727cc3`); duplicate `stateige.yml.example` add (`a45c4498`); the `18a97adb`+`ef956145` change/revert pair (net zero); ~21 upstream back-merges and ~7 intra-fork plumbing merges.

## 13. Product → Mozambique Customization Matrix

| # | Area | DIGIT Product | Mozambique Customization | Files/Module | Commit(s) |
|---|---|---|---|---|---|
| 1 | Frontend | No public page; anonymous → login | Public landing + privacy + tutorial site, MDMS-driven, PT-first | `products/pgr/.../Landing/` (33 files) | `ccd8b576`, `0dce489b` |
| 2 | Frontend | 5-step generic complaint form | 3-step wizard, authority dispatcher, dynamic fields, drafts, consent | `CreatePGRFlowV2.tsx` | `81054330`, `22b8e38a` |
| 3 | Frontend | Hardcoded action modal allowlist | Workflow-metadata-driven action modals | `PGRDetails.js`, `PGRWorkflowModal.js` | `772a5986` |
| 4 | Frontend | Reopen/rate route nowhere | History-derived routing to prior Supervisor/Case Manager | `utils/workflowAssignee.js` | `adbf2da4`, `4d268d8f` |
| 5 | Frontend | Inbox = assignee-based only | Reception inbox by `createdBy` + "only my complaints" | `UICustomizations.js`, `OnlyMyComplaintsFilter.js` | `74eac21c`, `46d9081d` |
| 6 | Frontend | No admin-wide search | Cross-department admin search + Excel export | `AdminSearch.js` | `a0e18a4b`, `8da74a9e` |
| 7 | Frontend | No confidentiality display rules | Identity masking; Complainant card | `TimeLineWrapper.js`, `PGRDetails.js` | `992735af`, `c0c6f30b` |
| 8 | Frontend | Basic image upload | Shared uploader; video/audio playback; per-step attachments | `PgrFileUpload.js`, `attachmentKind.js` | `6bf0084a`, `e81431c2` |
| 9 | Frontend | `additionalDetail` replaced on reopen/rate | Merge-not-replace; 72h reopen window; mandatory reason | `utils/additionalDetail.js` | `92eaec23`, `8597982d` |
| 10 | Frontend | en_IN hardcoded; state-tenant loc only | Default locale honoured; city overlay; raw-key guards | `Localization/service.js` ⚠ | `812b36b8`, `3289ac3f` |
| 11 | Frontend | DIGIT branding, pinned CSS | Fala Cidadão brand; MDMS ThemeConfig colours | `overrides.css`, `index.html` | `954e134d`, `11c372d8` |
| 12 | Frontend | Map at logged-in tenant | Map/boundaries at authority tenant; loop guard; XSS escape | `GeoLocations.js`, `useMapConfig.js` | `62335750`, `8c1120f9` |
| 13 | Frontend | Boundary prefetch at mount; codes in address | Reliable cascade; readable address; postal code retired | `BoundaryComponent.js` | `da545a8a`, `4aa5aa3b` |
| 14 | Frontend | No channel-of-receipt | In-person/email/letter/Linha-Verde chips → `service.source` | `ChannelChipsComponent.js` | `6de45287`, `b2272873` |
| 15 | Frontend | No analytics | Default-off MDMS-driven analytics shim, PII scrubbing | `public/analytics.js` | `e9a0f0e4` |
| 16 | Frontend | No testing-tenant concept | `isTestingTenant` scoping + `/digit-ui-test` | `utils/testingTenant.js` | `d83aa600` |
| 17 | Frontend | Multi-module citizen shell | Single-module sidebar/redirect; avatar; logout fix | `citizen/index.js` ⚠ | `7a1afeeb`, `295b0756` |
| 18 | Frontend | Shared error-button key; S3-only image | Dedicated key + image fallback + layout | `ErrorComponent.js` ⚠ | `20ef8760` |
| 19 | Backend | Platform scoping only | Department-scope service (opt-in) | `EmployeeDepartmentScopeService.java` | `fe7cab60` |
| 20 | Backend | No geographic scoping | Jurisdiction scoping incl. subtrees (opt-in) | `EmployeeJurisdictionScopeService.java`, `BoundaryUtil.java` | `9e650397`, `79dae4ef` |
| 21 | Backend | No admin endpoint | `/v2/request/_admin/_search` rows+count | `AdminComplaintSearchController.java` | `dae9ec08` |
| 22 | Backend | `createdBy` param ignored | Real `createdBy` filter | `RequestSearchCriteria.java` | `1f9b68a2` |
| 23 | Backend | All-or-nothing masking | `x-no-mask` selective visibility | `EncryptionDecryptionService.java` | `8746bcab` |
| 24 | Backend | Hardcoded escalation states | `pgr.escalation.states` configurable | `EscalationScheduler.java` | `718d65b1` |
| 25 | Backend | web/mobile sources only | +email, inperson, letter, linhaverde | `application.properties` | `b2272873` |
| 26 | Backend | First-match recipient; terminal-assignee break; dept crash | Newest-match; safe terminal transitions; dept fallback; new placeholders | `NotificationService.java`, `WorkflowService.java` | `f05c52d5`, `4fa8964c`, `15ec1db5` |
| 27 | Notifications | Novu stack mandatory | Direct SMS (Ozeki HTTP) + SMTP mode; OTP pipeline; Ozeki via Novu | `DirectDeliveryService.java`, `OzekiOverridesBuilder.java` | `91aded4c`, `a95f8df2`, `a3be88e5` |
| 28 | Workflow | Flat GRO/LME workflow | CMS 4-tier workflow variant | `CmsPgrWorkflowConfig.json` | `bffdce15` |
| 29 | Roles | Stock DIGIT roles | 13 new roles + ~2,100 grant lines | ACCESSCONTROL seeds | `e79f0847`, `8e8c16dd` |
| 30 | MDMS | No dispatcher/dynamic-field masters | RelatedToMap / TemplateType / ExtendedAttributeSchema (+IGE/IGSAE) | ddh seeds + schemas | `23326ca2`, `8746bcab` |
| 31 | MDMS | Static landing | LandingSection/LandingPageConfig + seeds | ddh + `docs/migration/landing-config/` | `421db133` |
| 32 | MDMS | citymodule w/o banner | `bannerImage` + repair script | `tenant.json`, `fix-citymodule.sh` | `00ffd59f`, `ba39a55d` |
| 33 | MDMS | PrivacyPolicy in wrong module | `commonMDMSConfig.PrivacyPolicy` + PT/EN | ddh schema+seed | `c3e42214`, `039494e7` |
| 34 | Localization | en_IN + hi_IN seeded | pt_PT packs; Fala Cidadão copy; city overlays | ddh `localisations/` | `f42ad659`, `9597f0ab` |
| 35 | Configurator | No landing editing | Visual Landing Page Builder | `admin/landingBuilder/` (14 files) | `c2803e7f` |
| 36 | Configurator | Hardcoded telemetry, always on | AnalyticsProvider editor + kill switch | `AnalyticsProvidersEditor.tsx`, `telemetryGate.ts` | `1fd0711e` |
| 37 | Configurator | All masters editable | `writeRoles` gating (fail-closed) | `useCanWriteResource.ts` | `a82a9508` |
| 38 | Configurator | role-actions read-only | Role-actions create/edit from UI | `App.tsx`, registry | `31048d69`, `6135b38f` |
| 39 | Configurator | en_IN boot; stale loc caches | Env-default locale; save-time cache bust | `i18nProvider.ts`, `useLocalizationSaveRefresh.ts` | `833f759d`, `3d6fc082` |
| 40 | Configurator | Deploy-time testing tenant | `isTestingTenant` checkbox + guard rails | `TestingTenantToggle.tsx` | `0cfebb60` |
| 41 | Deployment | No unified migration | `ccrs-migrate.cjs` 9-phase runner (+Matomo) | `docs/migration/` | `16b91133`, `1abef50f` |
| 42 | Deployment | No gzip on UI bundle | gzip + no-cache all render paths; runbook | nginx templates, `enable-gzip.sh` | `874ec205` |
| 43 | Deployment | Single UI entrance | Password-gated `/digit-ui-test` (default OFF) | ansible templates | `06ee871e` |
| 44 | Deployment | DDH compose service | DDH retired; seeds via `full-dump.sql` | compose files | `6e72eed5`, `f4d37bbd` |
| 45 | Deployment | — | Escalation script + runbook; pilot deploy script; HTTPS guide | `enable-escalation.sh`, `deploy-pilot-fe.sh` | `718d65b1`, `b0d99e14`, `938623bd` |
| 46 | CI | Product CI only | Security scanning (Checkov/KICS/Strix + AI triage + dashboard), manual, report-only | `.github/` (15 files) | `bc0ecdac`, `57e28906` |
| 47 | Docs | Product docs | PRD/design, migration guides, runbooks, analytics guide | `docs/` (32 files) | `ab8c3a2c`, `48e4bc08` |
| 48 | Tests | Postal-code specs | `tests/` area: 1 deleted, 1 modified (feature retired). Repo-wide: 19 test files touched (8 added, 10 modified, 1 deleted) | `tests/integration-tests/` | `4aa5aa3b`, `ac4ce48a` |

## 14. Documentation Index

| Document (on `origin/master`) | Purpose |
|---|---|
| `docs/mozambique-customizations.md` | Official customization record — backend-only today; needs §15 additions |
| `docs/README.md` | Docs entry point |
| `docs/superpowers/specs/mozambique-prd/…` | Mozambique PRD / solution design |
| `docs/migration/README.md` + `ccrs-migrate.cjs` | THE post-deploy migration runner |
| `docs/migration/seed/…` | MDMS seed data + onboarding guides |
| `docs/pgr-escalation/RUNBOOK.md` | Escalation enablement runbook |
| `docs/pgr-landing/…` | Landing page design docs |
| `docs/analytics-guide/` (6 files) | Analytics setup/ops incl. self-hosted Matomo |
| `docs/dashboard-configuration/` (10 files) | KPI catalog, packs/RBAC (largely upstream) |
| `docs/ops/digit-ui-compression.md` | gzip runbook |
| `docs/enabling-https-with-letsencrypt.md` | HTTPS setup |
| `docs/rapid-release-approach.md` | Release-pipeline proposal |
| `docs/2.12-beta/…` | Upstream product release notes |
| `.github/SECURITY-SCANNING.md`, `SECURITY-SCOPE.md` | CI security-scan docs |
| On the v1.0.0 tag only (NOT on master) | Previous release's matrix/notes/manifest — stranded on a side branch |

**Missing documentation:** frontend customization record; V2.12 release notes/matrix/manifest on master; roles & permissions reference; notification-template coverage for CMS states.

## 15. Missing / Undocumented Changes

| Priority | Area | Missing Item | Evidence | Recommended Action |
|---|---|---|---|---|
| P0 | Backend | Jurisdiction scoping widened to boundary **subtrees** — doc says "exact match" | `79dae4ef` | Correct doc + properties comment |
| P0 | Frontend | The entire frontend (21 areas, §5) undocumented | 139-file diff | Add a Frontend section (this file's §5 is the draft) |
| P0 | Roles | 13 roles + ~2,100 grants undocumented; CMS_VIEWER misnamed; DGRO grant-less | `8e8c16dd`, `bffdce15` | Document role model; review grants |
| P1 | Backend | website/rate/reopen-link placeholders | `15ec1db5` | Add to doc |
| P1 | Backend | OTP expiry message 10→5 min — text only, real TTL not verified | `0ac4b3f0` | Verify TTL matches, then document |
| P1 | Config/MDMS | All new masters | §7 | Add Configuration/MDMS section |
| P1 | Configurator | All 10 configurator features | §7 | Add Configurator section |
| P1 | Workflow | CMS variant + escalation runbook not cross-referenced | `bffdce15`, `718d65b1` | Cross-reference |
| P1 | Deployment | Section A items: OTP enablement gap, uncommitted user-service params, password hardcodes | Section A | Raise as Git issues; land fixes |
| P2 | Backend | Client-facing `department` search field | `4a6537c3` | Add to doc |
| P2 | Deployment | DDH retirement ordering dependency | `6e72eed5`, `f4d37bbd` | Document migration path |
| P2 | Frontend | 25 upstream-subtree edits (merge debt) | §5 | Record; upstream the video-CSS fix |
| P2 | CI | Security scanning is report-only, manual | `.checkov.yaml` | State it is not a gate |
| P3 | Localization | pt_PT corruption incident | `34f87acc` | JSON-validity check in release steps |

## 16. Release Gaps & Product Decisions

**Recorded product decisions:**
- **D-1 (IGE/IGSAE):** the product retains full two-authority functionality (schemas, dynamic fields, masters for both IGE and IGSAE). For this deployment, IGSAE is **disabled by configuration** (MDMS `active: false`, `21ff33d5`/`07bd5c4c`) — a deliberate deployment choice, not removed product capability.
- **D-3 (mobile app):** the Flutter WebView mobile app is merged to the repository (`mobile/`, PR #61) but is NOT part of this release tag; it is announced as "coming next" in the release notes and ships with the next deployment.
- **D-2 (rate stale-cache):** rate's stale-cache exposure accepted, terminal states only (`aafa912b`).

**Open gaps:**
1. **Section A items** — OTP enablement flag doesn't de-mock Kong; second-OTP registration failure (fix uncommitted); hardcoded `eGov@123` in the playbook (line 4400 literal + mixed defaults). None fixed in the repo.
2. Confidentiality is display-only; backend masking gated on `CONFIDENTIAL_COMPLAINT_VIEWER` not wired end-to-end.
3. CMS role registration incomplete — 3 of 8 roles need a manual post-deploy step.
4. No geography drill-down (upstream CCSD-2171 not in this fork).
5. Notification templates/routing for CMS workflow states — recorded as missing at v1.0.0, not re-verified since.
6. Automated test coverage is thin: 19 test files touched across the delta, concentrated in analytics, scoping and notifications — none for workflow transitions, localization, or roles/permissions.
7. Configurator telemetry: hardcoded external keys, fails open, `sendDefaultPii: true` — data-residency decision.
8. `x-no-mask` exposes `entityName`/`entityAddress` on confidential IGSAE complaints — needs data-protection sign-off.
9. Known accepted quirks: admin-search `totalCount` echo ("N+" count — a pagination/display quirk, unrelated to the endpoint item removed by reviewer decision #1), RATE assignee retry.

## 17. Testing / UAT Status

Verifiable from the repository/documentation only:
- UAT environment `cms-pilot.digit.org` exercised during the v1.0.0 release analysis (2026-08): citizen creation, assignment chain, resolve/reopen/rate, notification dispatch, uploads, dashboard render.
- Formal UAT sign-off: **NOT VERIFIED** (no record in the repository).
- Automated coverage: 19 test files touched across the whole delta (8 added, 10 modified, 1 deleted) — concentrated in analytics (786-line shim suite, provider rules), backend scoping (jurisdiction/boundary/department), and novu-bridge direct delivery; none for workflow transitions, localization, or roles. Postal-code specs retired with their feature.
- The ~102 commits after 2026-08-14 have no recorded UAT evidence in the repository.

## 18. Final Readiness Assessment

## NEEDS REVIEW

The release documentation (this file) now captures the complete meaningful customization set — the repository's own docs do not yet (§15). Remaining before tagging:

1. **Section A** — decide and land: Kong de-mock tied to `enable_otp_services`; commit the two user-service registration parameters (or the code fix on `fix/otp-register-double-consume`); fix the playbook password hardcodes. These affect production logins and deployments and are currently environment-only fixes.
2. Update `docs/mozambique-customizations.md` per §15 (a day's work from this file).
3. Validate pt_PT JSON bundles.
4. Product sign-offs: telemetry data residency (§16.7), `x-no-mask` PII carve-out (§16.8).
5. Tag `CMS-MOZ-V2.12` on `origin/master` @ `57e28906` once the above are accepted or explicitly deferred.

---

## Proposed Tag

`CMS-MOZ-V2.12`

**Status: PREVIEW ONLY — TAG NOT CREATED** · nothing pushed · no release published · no repository modified
