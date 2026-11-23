# DEPLOYMENT.md — DIGIT Complaint Management System, Mozambique

**Release:** `cms-mozambique-v1.0.0` (annotated git tag — not `v1.0.0`)
**Release commit:** `124678e55b6f59aeba61bae753e6b00ef842dfb7` (branch `master`, "Create stateige.yml.example (#3)", 2026-08-14)
**Repository:** `eGov-Global/CMS-MOZAMBIQUE`
**Upstream baseline:** `egovernments/Citizen-Complaint-Resolution-System` @ `343617ceab56b28ced9ad276286d9afc0ef613a8` (branch `release-v2.12-moz`)

This guide is written for an engineer who has never seen this repository. Every step is either a command you run or an explicit statement that the repository does **not** automate it. Anything unknown is marked **NOT VERIFIED** — do not guess in its place.

---

## 0. What this release is, and what it changes on a server

`cms-mozambique-v1.0.0` is a **documentation release**. It contains no application code changes: the fork-local delta between the upstream baseline `343617ce` and the release commit `124678e5` is

```
git diff --stat 343617ce 124678e5
=> 2 files changed, 293 insertions(+)
   .github/CODEOWNERS                                              +3
   local-setup/ansible/inventory/host_vars/stateige.yml.example   +290
```

Deploying this tag therefore deploys **the same runtime artefacts** as the upstream `release-v2.12-moz` line at `343617ce`. The Mozambique product customisation itself (556 commits, 256 files, +31,277 / −2,288 versus upstream product master `815b2374`) was authored and merged **inside the upstream repository**; this fork mirrors it.

Three consequences that shape this whole document:

1. **Deploy-time CMS role seeding is NOT in this release.** The upstream commits that add it (`6c19c0c1`, `3ea00efc`, `6e9f1fe5`, `a697917d`, CCSD-1937) landed after the fork's last sync. Verified at the release commit: `local-setup/ansible/playbook-deploy.yml` contains **zero** occurrences of `cms`. `node docs/migration/ccrs-migrate.cjs --only cms` is a **MANUAL post-deploy step** (Section 9).
2. **CCSD-2171 (analytics `boundaryPath` subtree parameter and dashboard geography drill-down) is NOT in this release** (`1dfc82cd`, `45ee087a`, `943c42de`, `1f082e60`, `b55c8533`). Do not expect or test for it.
3. **There are ZERO Mozambique-specific database migrations.** `git diff --name-only 815b2374...master -- '*.sql'` returns nothing; all 22 Flyway migrations are byte-identical to upstream. There is no Moz-specific migration to run on a fresh install or an upgrade, and nothing schema-related blocks an image rollback.

---

## 1. Deployment model at a glance

| Property | Value |
|---|---|
| Mode | **Mode A** — single Linux VM, Docker Compose, driven by Ansible from an operator's controller |
| Entry point | `local-setup/ansible/deploy.sh <tenant>` → `playbook-deploy.yml` (268 named tasks) |
| Stack size | 60 top-level services in `local-setup/docker-compose.egov-digit.yaml`, plus overlays |
| Gateway | Kong, declarative config `local-setup/kong/kong.yml` |
| Continuous monitoring | Gatus, `local-setup/gatus/config.yaml` (51 checks), served at `/status/` |
| CD pipeline | **None.** GitHub Actions only builds and publishes `egovio/*` images. Promotion to a host is an operator-run `./deploy.sh`. |
| Rollback automation | **None.** See Section 14. |

Only ~7 first-party backend services exist in this tree (`pgr-services`, `digit-config-service`, `novu-bridge`, `novu-bridge-endpoint`, `novu-dashboard`, `digit-user-preferences-service`, `xstate-chatbot`, plus `utilities/default-data-handler`, `utilities/otp-publisher`, `digit-mcp`, `turbopass/search-api`). **All other DIGIT services are prebuilt `egovio/*` images with no source in-tree.** Java services are Java 17 / Spring Boot 3.2.2 (`pgr-services` 3.0.0).

The product frontend is **`digit-ui-esbuild`** (esbuild React 17 SPA, served at `/digit-ui`). `digit-ui-v2` and `frontend/micro-ui` are legacy and NOT deployed. `configurator` (DIGIT Studio) is active for Mozambique.

---

## 2. Prerequisites

### 2.1 Controller machine (where you run `deploy.sh`)

| Requirement | Notes |
|---|---|
| Checkout of this repo at the release tag | Seed files, templates and compose files are read from the checkout |
| `ansible-playbook` on `PATH` | `deploy.sh` exits **127** with install hints if missing |
| `ansible-lint`, `yamllint` | Optional to install, but if present they **run by default and block the deploy** on violations. Bypass: `SKIP_LINT=1` |
| `python3` | Required by `local-setup/scripts/preflight.py`. Bypass: `SKIP_PREFLIGHT=1` |
| Key-based **root SSH** to the target host | |
| Ansible collections | `ansible-galaxy collection install -r local-setup/ansible/requirements.yml` |
| Outbound internet | The OTEL Java agent JAR (~21 MB) is downloaded on the controller before the rsync |

```bash
git clone https://github.com/eGov-Global/CMS-MOZAMBIQUE.git
cd CMS-MOZAMBIQUE
git checkout cms-mozambique-v1.0.0
git rev-parse cms-mozambique-v1.0.0^{commit}   # must print 124678e55b6f59aeba61bae753e6b00ef842dfb7
ansible-galaxy collection install -r local-setup/ansible/requirements.yml
```

The `nairobi-mdms` submodule is initialised only when `requires_nairobi_mdms: true` — it is `false` for Mozambique.

### 2.2 Target host

| Requirement | Detail |
|---|---|
| OS | Debian family (apt) or RHEL family (dnf: Rocky / Alma / CentOS Stream / RHEL). A thin macOS path exists but is for laptops. The playbook **fails fast** on anything else. |
| Docker | Installed **by the playbook** (repo + GPG key; it removes the conflicting Ubuntu-archive `docker.io` / `docker-compose-v2`) |
| Docker Compose | **≥ 2.20** enforced by a playbook gate (`group_vars/all.yml: docker_compose_version_min`) |
| JDK on the host | **Not needed.** Every DIGIT service is a container. |
| Node.js | **Node 20 required on the host** for the `digit-ui` / `configurator` / `digit-ui-v2` builds. Installed by the playbook from NodeSource. |
| Also installed by the playbook | nginx, python3/pip, Newman |
| Root/sudo | `deploy_become: true` in host_vars for apt/nginx |
| Firewall | Inbound 80 + 443 (host `ufw` **and** cloud security group) — **NOT automated** |
| Disk layout | If `/` is small, set `docker_data_root: "/opt/docker"` in host_vars **before the first ever Docker start** on that box; it also relocates containerd's root |

**Production sizing is NOT stated anywhere in the repository.** The only RAM/disk figures that exist are laptop bring-up numbers — WSL2 "≥ 16 GB RAM, ~60 GB free disk"; macOS "≥ 16 GB to the Docker VM, ≥ 30 GB free host disk"; `enable_search_stack` adds ~2–3 GB. **NOT VERIFIED:** the correct Linux production sizing for a Mozambique instance.

### 2.3 External services required

| Service | Why | Gate |
|---|---|---|
| Docker Hub (`egovio/*`) | Every core image **and** every `-db` Flyway migrator image | always |
| GitHub | `theflywheel/digit-ui-esbuild` clone (SPA source) | always (static/container FE build) |
| A container registry for `digit-mcp` | Only when `enable_mcp: true` and `build_mcp: false` | `enable_mcp` |
| NodeSource + Docker apt/dnf repos | Host provisioning | always |
| Let's Encrypt | TLS via certbot | manual, Section 12 |
| Google Maps (`gmaps_api_key`) | Map tiles in the UI | if set |
| `overpass-api.de` | Geocoding, unless self-hosted Overpass is enabled | `enable_overpass` |
| Twilio / Ozeki | Novu SMS / WhatsApp | `enable_novu` |
| Google IdP | Keycloak federation | `enable_keycloak` |
| S3 bucket (`asset_s3_bucket`) | Filestore fallback | if set |

---

## 3. Release inputs: images and how they are pinned

Images are built by GitHub Actions from `build/build-config.yml` (13 build jobs producing 18 images, including the `-db` Flyway images) and pushed to Docker Hub as `egovio/<name>:<branch>-<shortsha>` (`build.yml`), `develop-<sha8>` (nightly) or `egovio/<name>:<release-tag>` (`release-build.yml`). Frontends go through `spa-build.yml`.

**Only SEVEN compose services read their image from `/opt/digit/.env`, i.e. only these seven can be pinned from `host_vars`:**

```yaml
pgr_services_image:    # ${PGR_SERVICES_IMAGE}
digit_ui_image:        # ${DIGIT_UI_IMAGE}
configurator_image:    # ${CONFIGURATOR_IMAGE}
mcp_image:             # ${MCP_IMAGE}
novu_dashboard_image:  # ${NOVU_DASHBOARD_IMAGE}
novu_bridge_image:     # ${NOVU_BRIDGE_IMAGE}
otp_publisher_image:   # ${OTP_PUBLISHER_IMAGE}
```

Everything else (all core DIGIT services) is a **hardcoded tag inside `local-setup/docker-compose.egov-digit.yaml`**. Changing one of those requires editing that tracked compose file or shipping a per-tenant `local-setup/docker-compose.<tenant>.yml` overlay. **NOT AUTOMATED.**

Two known foot-guns:

- **`EGOV_USER_IMAGE` is rendered into `/opt/digit/.env` but no compose file consumes it.** `egov-user` hardcodes `egovio/egov-user:2.12-87e13fe` and its migrator hardcodes `egovio/egov-user-db:2.12-87e13fe`. Setting `egov_user_image:` in host_vars is **silently inert**.
- **`build_default_data_handler:` is inert in this release.** `default-data-handler` was removed from the compose stack and the playbook at the release commit consumes no such variable (verified: no `default_data_handler` variable reference in `playbook-deploy.yml`). The `default-data-handler` resource tree is still used — but only as **seed files read from disk** by `ccrs-migrate.cjs` and the notification seeder.

Because this release contains no Mozambique DB migrations, **no `-db` migrator tag needs to be bumped for it.** (For future releases: a new `V…sql` only reaches a host when someone manually bumps `egovio/<service>-db:<tag>` in `local-setup/docker-compose.migrations.yml`.)

---

## 4. `host_vars` configuration

Configuration is three layers:

```
inventory/group_vars/all.yml      digit_dir=/opt/digit, compose min version, docker_data_root
inventory/group_vars/digit.yml    cross-tenant DIGIT defaults (ports, nginx_features, digit_ui_mode: static, …)
inventory/host_vars/<tenant>.yml  everything country/instance specific   <-- YOU WRITE THIS
```

**Real `host_vars/*.yml` files are gitignored.** Only `.example` files are tracked, so the actual Mozambique production inventory is not in either repository. Start from one of:

- `local-setup/ansible/inventory/host_vars/_example.yml` (567 lines, upstream, fully commented)
- `local-setup/ansible/inventory/host_vars/maputo.yml.example` (upstream, `mz` + `mz.maputo`)
- `local-setup/ansible/inventory/host_vars/stateige.yml.example` (**fork-only, added by this release**, 290 lines)

```bash
cp local-setup/ansible/inventory/host_vars/stateige.yml.example \
   local-setup/ansible/inventory/host_vars/<tenant>.yml
```

No inventory edit is needed — `deploy.sh` regenerates `inventory/hosts.yml` from every `host_vars/*.yml` on disk (except `_example.yml`) on every run.

### 4.1 Mandatory / high-impact keys

| Key | Mozambique value in the shipped example | Note |
|---|---|---|
| `ansible_host`, `ansible_connection`, `deploy_become` | `localhost`, `local`, `true` | **Change** `ansible_host`/`ansible_connection` for a remote box |
| `domain`, `tls_enabled` | `localhost`, `false` | **Change for any real server** |
| `state_root`, `state_tenant_id`, `boot_tenant`, `tenant_id`, `ui_state_tenant_id` | all `mz` | `boot_tenant` pins the tenant the stack boots against |
| `login_tenant_allowlist` | `['mz']` | |
| `pgr_boundary_highest_level` / `_lowest_level`, `boundary_type`, `hierarchy_type` | `Provincia` / `Municipio`, `Municipio`, `divisao_administrativa` | |
| `core_mobile_configs` | `+258`, `^8[0-9]{8}$` | A task-level assert rejects the retired field names |
| `map_center` | `{ lat: -0.7817, lng: 35.3428 }` | **These are the inherited Bomet (Kenya) coordinates — change them** |
| `core_postal_configs` | present | Header comment flags it as "ADJUST for Mozambique" |
| `nginx_features` | `brand_assets`, `configurator`, `status`, `api_pgr`, `mcp`, … | Drives which nginx location blocks render |
| `digit_ui_mode` | `container` | `group_vars` default is `static`; see Section 10 |
| `db_fast_path` + `db_fast_path_ack_data_wipe` | both `true` in the example | **Only for a box with no data worth keeping.** Preflight refuses `db_fast_path` without the explicit ack |
| `secrets_path` | `kv/digit/bomet` in the example | **Change** to `kv/digit/<tenant>` |
| `bootstrap_secrets` | plaintext block | **Example/test defaults that MUST be changed** before any reachable deployment |
| `pgr_services_image` | `egovio/pgr-services:release-v2.12-moz-9deb7e0` | |
| `run_ci_tests` | `false` | Keep `false` in production; see Section 13 |
| `tolerate_bootstrap_failures` | `true` in the example | Set `false` in production so a partial tenant bootstrap fails the deploy loudly |

### 4.2 Known defects in `stateige.yml.example` (the file this release adds)

1. Its header is still the **Bomet (Kenya) example header** — "bomet.yml.example", "deploy.sh bomet", "Bomet County", a Kenya postal pattern marked "ADJUST for Mozambique" — while the values below are Mozambique. Read the values, ignore the header prose.
2. It sets `domain: localhost`, `ansible_connection: local`, `tls_enabled: false` — a **local-box** shape, not a server shape.
3. `secrets_path: kv/digit/bomet` and `map_center` are Bomet leftovers.
4. Its `bootstrap_secrets` (postgres, MCP DB, MinIO, Elasticsearch, HRMS default, Keycloak admin/DB, token-exchange system) are **example/test defaults that MUST be changed**. Never commit real values; they belong in OpenBao.

### 4.3 Secrets model

Per-tenant secrets live in **OpenBao** on the target at `secrets_path` (convention `kv/digit/<tenant>`). The **first** deploy initialises OpenBao (writes `init.json`, mode 0600), unseals it, enables kv-v2 at `kv/`, and seeds `bootstrap_secrets` with `cas=0` so **re-deploys never overwrite rotated values**. It then reads secrets back and writes them into `/opt/digit/.env` via an idempotent blockinfile, and syncs the postgres and mcp-postgres role passwords to the vault values. Keycloak secrets are written into `.env` *before* compose-up because containers need them at boot.

Rotation: `bao kv put …`, then re-run the playbook from the task "OpenBao — write secrets into compose .env".

`local-setup/kong/kong.yml` ships two placeholder key-auth consumer credentials whose values end in `-change-me`. **Nothing in the deploy rotates them or fails on them.** Rotate them manually.

---

## 5. Pre-deploy checklist

```bash
# 1. DNS A record exists and resolves  (NOT AUTOMATED)
dig +short <your-domain>

# 2. Inbound 80/443 open on host and cloud firewall  (NOT AUTOMATED)

# 3. BACK UP THE DATABASE — the ONLY rollback insurance that exists  (NOT AUTOMATED)
ssh <host> 'docker exec docker-postgres pg_dump -U egov -Fc egov > ~/pre-deploy-$(date +%F).dump && ls -lh ~/pre-deploy-*.dump'

# 4. Dry run: `--check --diff` shows template diffs, but the playbook is dominated by shell/command tasks that are skipped in check mode, so a full clean `--check` run is NOT expected — treat a mid-run check failure as normal
cd local-setup/ansible && ./deploy.sh <tenant> --check --diff
```

There is **no `pg_dump` / backup task anywhere in `playbook-deploy.yml`**. Step 3 is on you.

---

## 6. The deploy command

```bash
cd local-setup/ansible
./deploy.sh <tenant>                 # full deploy
./deploy.sh <tenant> --check --diff  # dry run
./deploy.sh <tenant> --tags=notifications   # the ONLY usable tag — there is NO `nginx` tag (a --tags=notifications run silently does nothing)
```

`deploy.sh` in order:
1. Verifies `ansible-playbook` is on `PATH` (else exit 127).
2. Runs `ansible-lint` + `yamllint` over `playbook-deploy.yml`, `inventory/group_vars/`, `inventory/host_vars/` — **blocking** unless `SKIP_LINT=1`.
3. Regenerates `inventory/hosts.yml` from all `host_vars/*.yml`.
4. Runs `local-setup/scripts/preflight.py` against your host_vars — **blocking** unless `SKIP_PREFLIGHT=1`. Each rule cites the incident it encodes: fast-path data-wipe ack, fast-path Elasticsearch master password, half-wired Keycloak, `digit_ui_v2`, MCP registry (`mcp-needs-registry`: `enable_mcp: true` requires `docker_registry`), mobile-config schema, `boot_tenant`, `ci_tests`, `ui_mode`, `configurator`, Docker log rotation.
5. Execs `ansible-playbook -i inventory/hosts.yml --limit <host> playbook-deploy.yml`.

A further pre-task gate rejects UPPERCASE host_vars keys (they are read by nothing) and the retired `core_mobile_configs` field names.

Watch progress from a second terminal:

```bash
ssh <host> 'tail -f /opt/digit/digit-stack-up.<tenant>.progress'
ssh <host> "watch -n5 \"docker ps --format '{{.Names}}\t{{.Status}}'\""
```

The playbook has **almost no tags** (`mcp-publish`, `notifications`, `notification-seed`). Partial re-runs otherwise rely on `--start-at-task "<exact task name>"`.

---

## 7. What the playbook does, in order

Read this as the authoritative order of operations. (Task names, not line numbers — line numbers drift.)

**Pre-tasks**
1. host_vars naming preflight → optional force-clean teardown (containers + networks; **volumes preserved**) → `digit-ui` mode reconciliation (kills the wrong runner on :18080) → baseline CLI tooling → clone/update `/opt/digit-ui-esbuild`.

**Host provisioning**
2. OS / SELinux / mobile-config / WSL preflight.
3. Docker CE install + `daemon.json` (insecure-registries, log rotation, optional `data-root`).
4. Compose ≥ 2.20 gate.

**Files and configuration**
5. Create `/opt/digit`; copy the compose files.
6. Download the OTEL Java agent (on the controller), then rsync 11 config directories to the host: `otel, configs, nginx, kong, postman, db, seeds, gatus, jupyter, scripts, keycloak` + the `docker/` build contexts.
7. Render `/opt/digit/.env` from `templates/digit.env.j2`, `globalConfigs.js` (+ testing variant), and the container `digit-ui` nginx conf.
8. In-compose env patches applied by targeted `lineinfile`/`replace`: Grafana domain, `PARENT_LEVEL_TENANT_ID` (egov-inbox), `DIGIT_TENANT` (mcp/jupyter), `EGOV_MOBILE_VALIDATION_DEFAULT_COUNTRY_CODE` and `_REGEX` (egov-user).
9. Compute compose **profiles** and the `-f` file list (Section 8).
10. Local image builds where requested: `digit-mcp`, `novu-dashboard`, `otp-publisher`, `digit-ui`.
11. Keycloak / Novu secrets written into `.env` **before** compose-up.

**Bring-up**
12. `docker compose pull --ignore-pull-failures` (deliberately tolerates local-only tags such as `digit-mcp:local`).
13. `docker compose up -d` — **this is where DB migrations run** (Section 8).
14. Blocking health gates: `kong-gateway` healthy (60 × 10 s), `egov-persister` healthy, `egov-hrms` healthy (30 × 10 s); Prometheus reload.

**Frontends and gateway**
15. `digit-ui` static/hmr convergence + bundle verification; `digit-ui-v2` (optional); MCP health.
16. OpenBao init / unseal / seed / read / write into `.env` → **recreate services with the new env**.
17. `configurator` build + rsync to `/var/www/configurator` (when `build_configurator: true`).
18. Optional add-ons: turbopass, overpass, integration-tests dashboard.
19. Host nginx vhost render + handler flush (reload happens **before** validation).

**Tenant bootstrap**
20. Pre-generate `egov-enc-service` keys for `state_root` and `tenant_id`.
21. **MCP `/v1/tenant/bootstrap`**: clone `pg → <state_root>` and `pg.citest → <tenant_id>` (Section 9). Hard-fails the deploy on any reported seed failure unless `tolerate_bootstrap_failures: true`.
22. **Post-bootstrap tenant cutover** — the most fragile ordering in the deploy, fully automated: rewrite `STATE_LEVEL_TENANT_ID` / `EGOV_STATE_LEVEL_TENANT_ID` / `EGOV_STATELEVEL_TENANT` (HRMS) / `PGR_STATELEVEL_TENANTID` / `EGOV_UI_APP_HOST_MAP` / the inbox default / `hrms-prereq-gate` in the compose file → recreate every service **except** `egov-hrms` → wait for `egov-user` healthy → seed `INTERNAL_USER` with retries → ensure `ADMIN` exists → recreate `egov-hrms` → wait through Kong → re-provision `ADMIN` with the state-root and city enc keys.
   *Why:* `egov-workflow-v2` and `egov-enc-service` read their STATE_LEVEL tenant's MDMS at startup and crash-loop against a not-yet-bootstrapped tenant, so the stack boots against `pg` / `pg.citya` (which exist in the dump) and is cut over afterwards.
23. Configurator i18n upsert per locale; Novu / Keycloak bootstrap when enabled.
24. UI-tenant probe → re-render `globalConfigs.js` → nginx reload.

**Validation**
25. Validation gates and the printed `===== INFRA VALIDATION RESULTS =====` summary (Section 12); Loki; optional Claude Code; `notif-seed`; optional CI suites.

> **Not present in this release:** the CMS role/grant seed task (upstream CCSD-1937). After step 24 you must run Section 9 by hand.

---

## 8. Where database migrations run

Migrations run **inside `docker compose up -d`** — there is no separate Ansible migration step. `local-setup/docker-compose.migrations.yml` is layered on *every* compose invocation and **is** the migration model.

Order:

1. **`db-history-normalize`** (always active, no profile). Renames legacy `*_schema_version` history tables to the K8s `<service>_schema` names, and **aborts the deploy** on anything it cannot prove safe. Without it Flyway would replay from V1 and `egov-localization` / `egov-enc-service` would DROP and recreate their tables, destroying the encryption keys.
2. **`pgr-services-migration`** — additionally gated on `boundary-service`, `egov-user`, `mdms-backend` and `egov-workflow-v2` all `service_healthy`, because the analytics materialized views read their tables. History table `pgr_services_schema`.
3. **Repo-hosted migrators** (profile `notifications`): `novu-bridge-migration`, `digit-config-service-migration`.
4. **Core migrators** (gated only on postgres + normalize, therefore parallel): `audit-service`, `boundary-service`, `egov-user`, `mdms-backend`, `egov-idgen`, `egov-localization`, `egov-enc-service`, `egov-filestore`, `egov-workflow-v2`, `egov-hrms`, `egov-url-shortening`, `egov-otp` (profile `otp`).
5. **Init-container converts**: `egov-indexer` (profile `search`), `egov-bndry-mgmnt`, `egov-accesscontrol`.
6. The legacy consolidated `db-migrations` container is neutralised (`entrypoint: ["true"]`) so its unremovable `service_completed_successfully` gate is satisfied without running `migrate-all.sh`.
7. Apps start with `SPRING_FLYWAY_ENABLED: false`, each `depends_on` its migrator with `condition: service_completed_successfully`.

Invariants worth knowing: migrators connect **directly to `postgres-db:5432`**, never through the `pgbouncer` alias (transaction mode breaks Flyway session locks), and run with `FLYWAY_VALIDATE_ON_MIGRATE=false`.

**Fresh install with `db_fast_path: true`:** `local-setup/db/full-dump.sql` is mounted into `/docker-entrypoint-initdb.d` on an empty PGDATA (54 tables, real Flyway history, ~20K localization rows), so the migrators become quick no-ops and bring-up drops from roughly 5–10 min to 1–2 min. This wipes any existing data — hence the mandatory `db_fast_path_ack_data_wipe`.

**For this release specifically:** no Mozambique migration exists, so nothing new is applied and no `-db` tag bump is required.

**Migration gaps you must plan around (all release-wide, not Mozambique-specific):**

- **No down-migrations and no Flyway undo scripts exist anywhere.** Rollback = restore the whole database from a dump — which, because all services share the `egov` database, rolls back every other service too.
- Two migrations end with a **non-concurrent `REFRESH MATERIALIZED VIEW complaint_facts;`** (ACCESS EXCLUSIVE) inside the migration. Their duration on production-sized data is **unmeasured** and no timeout guidance exists. Plan a maintenance window when a release does carry migrations.
- **NOT VERIFIED:** whether the pinned migrator images (e.g. `egovio/pgr-services-db:2.12-beta-96dcf10`) contain the newest migration files. Because `VALIDATE_ON_MIGRATE` is `false`, a stale migrator image fails **silently**. Check with `docker run --rm --entrypoint ls egovio/pgr-services-db:<tag> /flyway/sql`.

---

## 9. Where MDMS / master data is seeded — and the MANUAL steps

Four distinct mechanisms. Only the first three are automated.

### 9.1 Automated during the deploy

| # | Mechanism | What it does |
|---|---|---|
| 1 | compose `user-seed` one-shot (`seeds/user-seed.sh`, via `egov-user-proxy`) | Guarantees `ADMIN` / `GRO` / `INTERNAL_USER` exist with the right encryption |
| 2 | **MCP `/v1/tenant/bootstrap`** | The main tenant seed: clones `pg → <state_root>` and `pg.citest → <tenant_id>`, seeding ~30 MDMS schemas, ~1K data rows, ~8K localizations, the PGR workflow, an ADMIN `eg_user` and an ADMIN HRMS employee, parameterised with the tenant's `mobileNumberRegex` / `countryCode`. Requires `enable_mcp: true`. |
| 3 | `notif-seed` + configurator i18n upsert | Three notification MDMS masters via `scripts/seed-notifications.py`, gated on `seed_notifications` / `pgr_notification_config_driven`; also runnable standalone with `--tags notifications` |

> `default-data-handler` is **not in the compose stack in this release**, so its boot-time MDMS/config/localization seeding does **not** happen. Its resource files are still read from the repo checkout by `ccrs-migrate.cjs` (Section 9.2) and the notification seeder.

### 9.2 MANUAL — CMS roles, actions, grants and the CMS PGR workflow

**This is the step the release does not automate.** Without it, employee onboarding fails with `Role "CMS_…" not valid`, because MCP bootstrap clones roles from the stock `pg` tenant baked into the dump, which predates the CMS role set.

Run **on the server** (or anywhere with gateway reachability), from a checkout of **this tag** — the runner reads seed JSON relative to the repo:

```bash
cd ~/CMS-MOZAMBIQUE          # a checkout of cms-mozambique-v1.0.0
node --version               # runner requires Node >= 14, zero npm deps

# 1. DRY RUN first — prints the plan, changes nothing
node docs/migration/ccrs-migrate.cjs \
  --host http://127.0.0.1:18000 \
  --tenant mz.ige \
  --user ADMIN --pass '<bootstrap password>' \
  --only cms --dry-run

# 2. Apply
node docs/migration/ccrs-migrate.cjs \
  --host http://127.0.0.1:18000 \
  --tenant mz.ige \
  --user ADMIN --pass '<bootstrap password>' \
  --only cms --report ~/cms-seed-$(date +%F).json
echo "exit=$?"    # EXIT CODE = number of FAILED phases; 0 = OK
```

Notes:

- `--host` is the **gateway**. Kong listens on host port **18000** (`upstream_kong_port`); `https://<domain>` also works once nginx and TLS are up.
- `--only cms` runs exactly that phase and implies `--cms`; auth is auto-prepended.
- **Tenant argument:** the `cms` phase writes roles at **both** the state root and the city tenant. Pass the **city** tenant (e.g. `mz.ige`). If a tenant *list* is passed, a bare state root in that list is skipped ("cms runs at the city tenants in the list"); a **single** state-root tenant runs directly against itself.
- Re-running is safe — the runner detects completed work and skips it (ensure-semantics).
- Full phase order if you run more than `cms`: `auth → schemas → hierarchy → pgr-masters → landing → cms → banner → gzip → verify`.
- The password is a secret: prefer `OAUTH_PASS=…` in the environment over a shell-history argument.

**What it actually registers — and what it does NOT:**

`ccrs-migrate.cjs` at this release filters the seed to exactly **five** roles:

```js
const CMS_ROLES = ['CMS_RECEPTION_OFFICER', 'CMS_SCREENING_OFFICER',
                   'CMS_SUPERVISOR', 'CMS_CASE_MANAGER', 'CMS_VIEWER'];
```

The seed files contain **more** roles than that. Verified in
`utilities/default-data-handler/src/main/resources/mdmsData/ACCESSCONTROL-ROLE/ACCESSCONTROL-ROLES.roles.json`: seven `CMS_*` roles (the five above plus `CMS_ADMIN` and `CMS_DASHBOARD_VIEWER`) **and** `CONFIDENTIAL_COMPLAINT_VIEWER` (which also has 16 grant rows in `ACCESSCONTROL-ROLEACTIONS.roleactions.json`).

> **MANUAL, NOT AUTOMATED:** `CMS_ADMIN`, `CMS_DASHBOARD_VIEWER` and `CONFIDENTIAL_COMPLAINT_VIEWER` are **not registered by this release**, even though features that need them **are** in the release. Register them by hand — create the matching `ACCESSCONTROL-ROLES.roles` rows (at the state root **and** the city tenant, mirroring what the runner does for the other five) and the corresponding `ACCESSCONTROL-ROLEACTIONS.roleactions` rows (at the state root), copying the definitions verbatim from the two seed files above.
> **NOT VERIFIED:** the exact operator-facing procedure for that manual registration (MDMS v2 `_create` calls vs the configurator UI) is not documented in the repository at this commit.

### 9.3 MANUAL — restart `egov-workflow-v2` after workflow seeding

The `cms` phase creates the PGR `BusinessService` at the city tenant when it is missing, and prints:

```
workflow CREATED — restart egov-workflow-v2 (it caches BusinessServices)
```

**Nothing performs that restart.** Do it yourself, then verify:

```bash
docker restart egov-workflow-v2
docker ps --filter name=egov-workflow-v2 --format '{{.Names}}\t{{.Status}}'

curl -s -X POST "http://127.0.0.1:18000/egov-workflow-v2/egov-wf/businessservice/_search?tenantId=mz.ige&businessServices=PGR" \
  -H 'Content-Type: application/json' -d '{"RequestInfo":{"authToken":"<token>"}}' | head -c 400
```

If the runner reported "workflow BusinessService already present", no restart is needed — and note that in-place diff/patch of an existing BusinessService requires the legacy `--update-wf` path.

### 9.4 MANUAL — post-deployment authority narrowing (product vs environment)

The product seed `docs/migration/seed/ComplaintRelatedToMap.json` ships **both** authorities active:

```json
[ { "code": "IGE",   "tenantCode": "mz.ige",   "tenantId": "mz", "displayOrder": 1, "active": true },
  { "code": "IGSAE", "tenantCode": "mz.igsae", "tenantId": "mz", "displayOrder": 2, "active": true } ]
```

For an **IGE-only launch**, the operator narrows the *environment* after deployment so that exactly **one** row is active. The citizen flow then auto-selects it and hides the authority picker.

Live `cms-pilot` state (verified): exactly one row — `IGE`, `tenantCode=mz`, `active=true`.
**Note the discrepancy: the pilot maps `IGE → mz` while the seed maps `IGE → mz.ige`. Which is intended is NOT VERIFIED.** Both are recorded here deliberately; do not silently "correct" either without deciding which is right for your environment and re-testing the citizen create flow.

### 9.5 MANUAL — tenant master data (the tenant is unusable without it)

Boundaries, departments, designations, complaint types / hierarchy and employees are **NOT seeded by the deploy**. The delta contains no Mozambique `tenant.tenants`, boundary, Department/Designation or ComplaintHierarchy data — all of it is operator-supplied XLSX, an **out-of-band dependency**. Use one of the three documented routes (`local-setup/docs/ONBOARDING-AND-ADDONS.md`): the configurator wizard, the Jupyter DataLoader, or MCP `city_setup_from_xlsx`. Skipping this leaves a technically healthy but unusable tenant.

### 9.6 MANUAL — country/environment corrections known to be wrong out of the box

| Item | Default from seed | Required for Mozambique |
|---|---|---|
| `common-masters.StateInfo.languages` | `['en_IN','hi_IN']` | Add `pt_PT`, otherwise a fresh `mz` environment has full Portuguese message packs but no way to select Portuguese |
| `common-masters.MobileNumberValidation` | Kenya (`+254`, `^0?[17][0-9]{8}$`) | `+258` / `^8[0-9]{8}$`. The Ansible `core_mobile_configs` route writes the container env; the MDMS master must also be correct, and the Redis `validationRules` key flushed |
| `dss.DashboardConfig` | tenant `ke`, `Africa/Nairobi`, no `CMS_*` in `allowedRoles` | Remap via `local-setup/scripts/enable-dashboard.sh` (`--dry-run` then `--repair`); **`timeZone` must be edited by hand** to `Africa/Maputo`. Run this LAST, after employees hold their roles, then flush the token store and re-login |
| Config-driven notifications on a CMS-variant tenant | `CmsPgrWorkflowConfig.json` has **no** per-action `notifications` blocks | The masters must be seeded by another route; do not assume notifications work after the CMS workflow seed |

After **any** localization upsert, flush the localization caches or the UI keeps serving stale messages:

```bash
docker exec digit-redis redis-cli DEL computedMessages messages
```

**Documentation defect to be aware of:** `docs/agency-category-tenant-mapping.md` documents an MDMS master `RAINMAKER-PGR.AuthorityConfig`. **That master does not exist** — the implemented master is `RAINMAKER-PGR.ComplaintRelatedToMap`. The design doc is stale.

---

## 10. Frontend build and publish

### 10.1 During the deploy (`digit_ui_mode`)

| Mode | Behaviour | Durability |
|---|---|---|
| `static` (group default) | Host nginx serves `/opt/digit-ui-esbuild/build/`. The playbook stops the `digit-ui` container and either extracts the baked `/var/web/digit-ui` out of `digit_ui_bundle_image` (robust, no on-host Node) or ensures Node 20, runs `npm install --legacy-peer-deps` when the lockfile is newer than `node_modules`, then `GLOBAL_CONFIGS=/opt/digit/nginx/globalConfigs.js node esbuild.build.js`. Asserts `build/index.html` exists. | **Durable** |
| `container` (value in the shipped Moz example) | The compose `digit-ui` image serves the bundle. With `build_digit_ui: true` a freshly built bundle is `tar`-piped into the running container (excluding `globalConfigs.js` and `silent-check-sso.html`). | **EPHEMERAL** — any `compose up` or image redeploy silently reverts the UI to the baked bundle |
| `hmr` | tmux esbuild dev server on :18080. Dev only. The `/digit-ui-test` testing entrance does **not** render in this mode. | dev only |

Per-tenant boot config is always `templates/globalConfigs.js.j2` → `/opt/digit/nginx/globalConfigs.js`, re-rendered once more at the end of the run after the UI-tenant probe.

Configurator: with `build_configurator: true` the deploy runs `files/configurator-build.sh` (`vite build --base=/configurator/`) and rsyncs `dist` into `/var/www/configurator`; otherwise the compose `configurator` image is proxied.

### 10.2 Between releases — `deploy-pilot-fe.sh`

Frontend-only refresh, run **on the server**:

```bash
ssh <box> 'bash ~/Citizen-Complaint-Resolution-System/local-setup/scripts/deploy-pilot-fe.sh [all|ui|configurator] [branch] [--no-pull]'
```

It checks out/pulls the branch (default `release-v2.12-moz`), rsyncs `digit-ui-esbuild/` into `/opt/digit-ui-esbuild`, runs `npm ci --legacy-peer-deps` only when the lockfile hash changed, builds with the server's `globalConfigs.js`, tars the bundle into the `digit-ui` container, **verifies `index.js` mtime inside the container**, then builds the configurator (deriving `VITE_STATE_TENANT_ID` from `globalConfigs.js`, default `mz`), rsyncs `dist` to `/var/www/configurator` and asserts `/configurator/` returns 200.

> The `digit-ui` copy it lays down is **ephemeral**. After any `digit-ui` container recreation, re-run `deploy-pilot-fe.sh ui --no-pull`. Only `digit_ui_mode: static` or a pinned `digit_ui_bundle_image` is durable.

### 10.3 Testing entrance (`/digit-ui-test`) — optional, default OFF

`testing_ui_enabled: false` by default. When enabled it renders a password-gated (`auth_basic` + `.htpasswd-testing`) alias of the **same** bundle with `globalConfigs.testing.js` (`TESTING_MODE=true`, `LOGIN_TENANT_ALLOWLIST=[testing_tenant]`) and a red banner. Two preconditions the deploy **cannot** enforce: it renders only in `digit_ui_mode: static`, and without the configurator "Make this a testing tenant" flag (`isTestingTenant` on `tenant.tenants`) it renders but is empty. `testing_ui_htpasswd` is a pre-hashed apr1 credential — keep it in the vault.

---

## 11. Host nginx, Kong and TLS

- Host nginx is installed by the playbook and its vhost rendered from `templates/nginx-site.conf.j2` to `sites-available/<domain>` (Debian) or `conf.d/<domain>.conf` (RHEL). **Do not hand-edit `/etc/nginx/sites-*`** — flip flags in host_vars and re-run. `nginx_preserve_vhost: true` makes the playbook install nginx but leave a hand-crafted vhost alone.
- Which location blocks render is driven by `nginx_features` (`brand_assets`, `configurator`, `configurator_caching`, `status`, `api_pgr`, `mcp`) and `digit_ui_mode`.
- Upstream ports: kong **18000**, grafana **13000**, gatus **18889**, mcp **13101**, esbuild **18080**, minio **19000**.
- Kong is declarative (`local-setup/kong/kong.yml`) and synced from the repo.
- Mozambique nginx delta: gzip + `Cache-Control: no-cache` **scoped to the `/digit-ui` location only** (bundle 7.2 MB → 2.1 MB).

### TLS — NOT AUTOMATED (first time only)

Run the playbook first so the HTTP vhost exists, then:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d <your-domain> --agree-tos -m <ops-email> --no-eff-email --redirect

sudo nginx -t
curl -sI https://<your-domain>/ | head -1
systemctl list-timers certbot.timer
sudo certbot renew --dry-run
```

The Ansible template already carries the `listen 443 ssl` lines, so Certbot's edits should be a no-op on a fresh box — verify after the playbook runs.

**Known recovery** — if `nginx -t` reports `/etc/letsencrypt/options-ssl-nginx.conf` not found, the cert is almost certainly still valid; **do not re-run certbot** (it burns rate-limit budget and re-edits the managed vhost). Restore the two helper files from the package data:

```bash
sudo install -m 644 /usr/lib/python3/dist-packages/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf /etc/letsencrypt/options-ssl-nginx.conf
sudo install -m 644 /usr/lib/python3/dist-packages/certbot/ssl-dhparams.pem /etc/letsencrypt/ssl-dhparams.pem
sudo nginx -t && sudo systemctl start nginx
```

---

## 12. Health checks

### 12.1 Blocking gates inside the deploy

`kong-gateway` healthy (60 × 10 s) → `egov-persister` healthy → `egov-hrms` healthy (30 × 10 s) → `digit-mcp` health → Loki `/ready` (non-critical) → the validation block:

- no container in `Restarting` / `(unhealthy)` / `Exited(non-zero)`;
- ten core services probed **through Kong**: `mdms-v2`, `user`, `enc`, `idgen`, `workflow`, `localization`, `boundary-service`, `access`, `common-persist`, `pgr-services`;
- `/digit-ui/` → 200; `/configurator/` → 200; `/status/` → 200; `/mcp` HEAD → 405;
- ADMIN token mint + `access_token` assertion;
- MDMS `StateInfo` non-empty;
- OpenBao unsealed + initialized;
- then the printed `===== INFRA VALIDATION RESULTS =====` summary. **A failure here fails the deploy.**

### 12.2 Continuous

Gatus at `/status/` — `local-setup/gatus/config.yaml`, 51 checks, profile-gated by the `GATUS_PROFILE_*` variables that `digit.env.j2` mirrors from the same host_vars flags that select the compose profiles (so monitoring cannot drift from what was deployed). Plus Prometheus, Grafana, Loki, Tempo and the OTEL collector.

```bash
curl -sI https://<domain>/status/                      # 200
curl -sI https://<domain>/grafana/api/health           # 200
ssh <host> "docker ps --format '{{.Names}}\t{{.Status}}' | grep -v healthy"
```

---

## 13. Smoke tests

Two Newman/Postman collections ship. They gate the deploy **only when `run_ci_tests: true`**, which every production/example host_vars sets to `false` — **so in production they do NOT run automatically.** Run them by hand:

```bash
newman run local-setup/postman/digit-core-validation.postman_collection.json \
  --env-var baseUrl=https://<domain>

newman run local-setup/postman/complaints-demo.postman_collection.json \
  --env-var url=https://<domain> \
  --env-var username=<user> \
  --env-var stateTenant=mz \
  --env-var cityTenant=mz.<city> \
  --delay-request 2000        # the persister is async — do not remove
```

`digit-core-validation` = 9 health checks (MDMS, ENC, IDGEN, user, workflow-v2, localization, boundary-service, access-control, persister) + 4 smoke tests; there is no filestore request.
`complaints-demo` = full PGR lifecycle: auth → search → create → assign → resolve → rate & close → search (bundled `pg.citest` tenant, CI credentials that are example/test defaults).

### 13.1 Manual acceptance for a Mozambique release

Automated coverage is effectively absent, so these must be done by a human. **Across all 556 commits of Mozambique customisation, exactly 1 test was added and 2 modified** (`configurator/src/providers/resolveInitialLocale.test.ts` added; `PGRServiceCountScopingTest.java` and `configurator/.../dataProvider.test.ts` modified). **There is no automated coverage for workflow transitions, notifications, extended attributes, roles/permissions, or localization — the single largest release-readiness gap.**

Minimum manual pass:

1. Citizen login (Mozambique 9-digit mobile, `+258`), complaint create end-to-end, attachment upload.
2. Authority selection behaviour matches your `ComplaintRelatedToMap` narrowing (Section 9.4): one active row → picker hidden and auto-selected.
3. Employee login for **each** CMS role you registered; confirm the inbox and the action set.
4. Every workflow transition you rely on (assign, refer, request info, resolve, reopen, rate) on a real complaint.
5. Notification delivery for at least one transition on each enabled channel.
6. Both locales (`pt_PT` and `en_IN`) on the login page, the citizen flow and the employee inbox — check for raw keys leaking through.
7. Dashboard visibility for a user holding a role in `dss.DashboardConfig.allowedRoles`, after re-login.

---

## 14. Rollback

**There is NO automated rollback anywhere in the repository** — no playbook task, no workflow, and nothing records a previous-good tag. The auto-rollback-on-failed-health-check described in `docs/rapid-release-approach.md` is a **proposal, not implemented**.

### 14.1 Image rollback (safe for this release)

`docs/rapid-release-approach.md` §6: image rollback is only safe if migrations are backward-compatible (expand-contract); a destructive migration means roll-forward only, and the release notes must say so. **This release adds no migrations at all, so an image re-pin is unobstructed.**

```bash
# 1. Re-pin the previous tags in host_vars/<tenant>.yml
#    pgr_services_image / digit_ui_image / configurator_image / …
# 2. Revert any <service>-migration tag bump in local-setup/docker-compose.migrations.yml
#    (not applicable to cms-mozambique-v1.0.0 — no migration was added)
# 3. Re-run the deploy
cd local-setup/ansible && ./deploy.sh <tenant>
```

Remember only seven services are re-pinnable from host_vars (Section 3); rolling back a core DIGIT service means editing the compose file or a per-tenant overlay.

### 14.2 Data rollback — restore from your own dump

Because there are **no down-migrations and no undo scripts anywhere**, the only data rollback is a full restore of the dump you took in Section 5, step 3:

```bash
docker exec -i docker-postgres pg_restore -U egov -d egov --clean --if-exists < ~/pre-deploy-<date>.dump
# then redeploy the previous pgr-services image and frontend
```

This restores **the whole shared `egov` database** — every service rolls back with it. There is no partial or per-service restore.

### 14.3 Seed/MDMS rollback

**Not possible in a versioned way.** The MDMS seeding layer has **no version table, no checksum and no applied-state record**; idempotency is re-derived on every run by probing the API. There is no way to answer "which seed version is this environment on" — `ccrs-migrate --report` captures a single run's outcome, not cumulative state. Undoing a seed means deactivating/deleting the specific MDMS rows by hand, or restoring the DB dump.

### 14.4 Feature-level rollback

Some behaviour is a host_vars flag flip plus a redeploy, e.g. `pgr_notification_config_driven: false` reverts PGR to the legacy notification path for that tenant.

### 14.5 Frontend rollback

Re-pin `digit_ui_image` / `digit_ui_bundle_image` and re-run the deploy, or re-run `deploy-pilot-fe.sh <target> <previous-branch-or-tag>` on the box.

---

## 15. Security notice you must read before exposing this deployment

**`POST /pgr-services/v2/request/_admin/_search` has NO authorization gate. This is NOT fixed in this release** (documentation-only release).

Verified facts:

- The controller performs **no role check**; its javadoc claims gateway gating **that does not exist**.
- **No `ACCESSCONTROL` action is registered for the URI** (0 hits in both action masters), there is **no `@PreAuthorize`**, and **no Kong route entry**.
- `AdminComplaintSearchService` validates only `tenantId` and sets `skipEmployeeDepartmentScope(true)`, **deliberately bypassing department ABAC**. Its two "SUPERUSER" mentions are **comments**.
- **Proven on the `cms-pilot` environment:** a user holding only `CMS_SCREENING_OFFICER` + `EMPLOYEE` received **HTTP 200 with complaint rows**.
- The only gate is client-side (`ADMIN_SEARCH_ROLES` in `digit-ui-esbuild/products/pgr/src/pages/employee/AdminSearch.js`), bypassable by calling the API directly.

Recommended fix (for a follow-up code release): enforce the role in the service/controller, **or** register the action plus a `roleactions` grant. Treat any operator-side network restriction as a compensating control you design and test yourself — **NOT VERIFIED** that one can be applied without breaking the legitimate admin-search UI.

---

## 16. What this repository does NOT automate (consolidated)

| Area | Status |
|---|---|
| Continuous deployment | **None.** Actions build/publish images only; nothing SSHes to a host or runs Ansible |
| Pre-deploy DB backup | **None.** No `pg_dump`/backup task exists in the playbook |
| Rollback (any kind) | **None.** Manual re-pin + manual `pg_restore` |
| Down-migrations / undo scripts | **Do not exist anywhere** |
| MDMS seed versioning / applied-state | **Does not exist** — no version table, no checksum |
| CMS role/grant/workflow seeding | **Manual in this release** (`ccrs-migrate --only cms`) |
| `egov-workflow-v2` restart after workflow creation | **Manual** |
| Registering `CMS_ADMIN`, `CMS_DASHBOARD_VIEWER`, `CONFIDENTIAL_COMPLAINT_VIEWER` | **Manual** |
| DNS A record, firewall, TLS/certbot | **Manual** |
| Tenant master data (boundaries, departments, designations, complaint types, employees) | **Manual**, out-of-band XLSX |
| Production smoke tests | **Manual** (`run_ci_tests: false` in production) |
| Migration propagation | Manual `-db` tag bump in `docker-compose.migrations.yml` |
| Re-pinning core (non-`pgr-services`) images | Manual compose-file / overlay edit |
| Kong placeholder key-auth credentials (`…-change-me`) | Nothing rotates them or fails on them |
| Mozambique production inventory | **Not tracked anywhere** — `host_vars/*.yml` is gitignored |

Additional known limitations that affect a deployment decision:

- **`develop` has diverged from `master`** (2 ahead / 1 behind) but **their trees are identical** — pure history duplication of `stateige.yml.example`. Technical debt, not a release blocker.
- **`PGR_WORKFLOW_VARIANT` is no longer set anywhere** after `default-data-handler` was removed from the compose stack (verified: zero occurrences repo-wide at `124678e5`). **NEEDS VERIFICATION** of the runtime effect on the CMS workflow variant before you rely on it.
- **The fork is diverged from upstream** (4 ahead / 9 behind `b55c8533`); a fast-forward resync is **not** possible and `reset --hard` would destroy the two fork-only files. Upstream sync is a separate post-v1.0.0 activity. Do not use upstream tag `v2.12-beta` as a baseline — it was force-moved (`8c7c4fe6` → `5f86a102`) and contains zero moz-line commits.

---

## 17. NOT VERIFIED (do not assume, confirm on your environment)

- The actual production Mozambique host: hostname, IP, domain, sizing, and which tenant slugs are live. Real `host_vars` are gitignored and absent from both checkouts.
- Whether the Mozambique pilot runs `digit_ui_mode: static` or `container` (`maputo.yml.example` and `stateige.yml.example` say `container`; the `group_vars` default is `static`; the live value is in an untracked file).
- Whether the `-db` migrator tags currently pinned in `docker-compose.migrations.yml` match the app image tags actually deployed on the Mozambique box.
- Whether per-tenant `docker-compose.<moz-tenant>.yml` overlays exist on the controller used for the real deploy (only `docker-compose.bomet.yml` is tracked).
- Whether Certbot/TLS is actually configured on the Mozambique production box (the repository documents only the procedure).
- Whether `IGE → mz` (live pilot) or `IGE → mz.ige` (product seed) is the intended `ComplaintRelatedToMap` mapping.
- Runtime behaviour of anything in this guide beyond what is stated: the underlying audit was a read-only repository analysis; no playbook, compose file or curl was executed against any environment as part of producing it.
- Duration of the two non-concurrent `REFRESH MATERIALIZED VIEW complaint_facts` statements on production-sized data.

---

## 18. File reference index

| Path (relative to repo root) | Role |
|---|---|
| `local-setup/ansible/deploy.sh` | The single deploy entry point |
| `local-setup/ansible/playbook-deploy.yml` | The deploy playbook (268 named tasks) |
| `local-setup/ansible/inventory/group_vars/all.yml` | `digit_dir`, compose min version, `docker_data_root` |
| `local-setup/ansible/inventory/group_vars/digit.yml` | Cross-tenant DIGIT defaults, upstream ports, `nginx_features`, `digit_ui_mode` |
| `local-setup/ansible/inventory/host_vars/_example.yml` | Fully commented host_vars template |
| `local-setup/ansible/inventory/host_vars/maputo.yml.example` | Upstream Mozambique template |
| `local-setup/ansible/inventory/host_vars/stateige.yml.example` | **Fork-only**, added by this release; stale Bomet header — read Section 4.2 |
| `local-setup/ansible/templates/digit.env.j2` | Renders `/opt/digit/.env` |
| `local-setup/ansible/templates/globalConfigs.js.j2` | Per-tenant UI boot config |
| `local-setup/ansible/templates/nginx-site.conf.j2` | Host nginx vhost |
| `local-setup/scripts/preflight.py` | Incident-derived config gate |
| `local-setup/scripts/deploy-pilot-fe.sh` | Between-release frontend refresh (run on the server) |
| `local-setup/docker-compose.egov-digit.yaml` | Base stack, 60 services |
| `local-setup/docker-compose.migrations.yml` | **The migration model** — always layered |
| `local-setup/docker-compose.fast-path.yml` | `db_fast_path` dump load |
| `local-setup/docker-compose.monitoring.yml` | node-exporter |
| `local-setup/db/full-dump.sql`, `local-setup/db/normalize/` | Fast-path dump; Flyway history normaliser |
| `local-setup/kong/kong.yml` | Declarative gateway config |
| `local-setup/gatus/config.yaml` | 51 continuous health checks |
| `local-setup/postman/*.postman_collection.json` | Smoke suites |
| `docs/migration/ccrs-migrate.cjs` | Unified idempotent migration/seed runner |
| `docs/migration/seed/ComplaintRelatedToMap.json` | Authority → tenant product seed |
| `docs/migration/operator-runbook.md` | Backup (§1) and rollback (§6) procedure |
| `docs/db-migration-flow.md` | Migration model and its invariants |
| `docs/deployment-modes.md` | Mode A / B / C |
| `docs/rapid-release-approach.md` | §4 SemVer + immutable tags; §6 expand-contract / roll-forward |
| `local-setup/docs/ONBOARDING-AND-ADDONS.md` | The three tenant master-data onboarding routes |
| `local-setup/ansible/README.md` | DNS, certbot, firewall, common operations |
| `utilities/default-data-handler/src/main/resources/mdmsData/ACCESSCONTROL-*/` | Role, action and grant seed files read by `ccrs-migrate` |