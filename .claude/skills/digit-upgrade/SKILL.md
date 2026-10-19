---
name: digit-upgrade
description: Use when an operator says "upgrade DIGIT", "move this box to the new release", "upgrade from beta to 2.12", "what did we change on the server", or similar. Upgrades an existing Ansible/Docker-Compose DIGIT box (any tenant, any version) to a newer release without losing data or customizations - finds hand edits in the deploy dir, checks the settings that can wipe data, takes backups, merges the new release into the operator's branch, runs deploy.sh, lists new MDMS data the release needs, and validates the result.
---

# DIGIT Upgrade

A generic, repeatable upgrade of an existing DIGIT box that was deployed with
`local-setup/ansible/deploy.sh`. Works for any tenant and any from/to version.

## Automated path

`local-setup/upgrade/upgrade.sh` runs Phases 1-8 below end to end (preflight, safety
check, drain, backup, access control, deploy, post-deploy, smoke) and `--rollback DIR`.
Prefer it for a real upgrade: `./upgrade.sh --config upgrade.conf.<tenant> --dry-run`,
then without `--dry-run`. Use the phases below to explain, investigate or run one step
by hand. The scripts in `scripts/` are the same helpers as `local-setup/upgrade/lib/`.

## IRON LAWS

```
1. READ FIRST, CHANGE LATER. Phases 1-3 are read-only. Never skip them.
2. NO BACKUP, NO DEPLOY. Phase 4 must finish and be verified before Phase 6.
3. NEVER, on a box with data: force_clean: true, `docker compose down -v`,
   deleting/renaming digit_dir, deleting the OpenBao volume or .openbao/,
   flipping db_fast_path from its CURRENT effective value, SKIP_PREFLIGHT=1
   to get past a data check.
4. ASK BEFORE: creating/merging branches, running deploy.sh, writing MDMS or
   DB rows, restoring a backup, touching /etc/nginx.
5. NEVER PRINT SECRETS. Report .env / host_vars secret keys by NAME only.
```

If a check fails or the playbook stops on a data guard (e.g. `db-history-normalize`
aborts), STOP and report. These guards abort *before* changing anything - do not
work around them.

## Why this skill exists (what deploy.sh does to an existing box)

| Thing | What every deploy.sh run does | Where customizations must live |
|---|---|---|
| `docker-compose.egov-digit.yaml` | copied from the repo, then tenant values patched in | `local-setup/docker-compose.<tenant>.yml` overlay (layered last, never overwritten) |
| `.env` | regenerated from `templates/digit.env.j2`; only OpenBao secret blocks kept | `host_vars/<tenant>.yml` (+ template if a new var is needed) |
| `kong/kong.yml` and other synced dirs (otel, configs, nginx, db, scripts, gatus, keycloak...) | rsynced from the repo | the operator's git branch |
| `nginx/globalConfigs.js`, `nginx/digit-ui.conf` | re-rendered | `host_vars/<tenant>.yml` |
| Postgres / MinIO / Mongo / OpenBao data | kept (named volumes) | - |
| Redis / Redpanda (Kafka) | kept on recreate; LOST on `down` (anonymous volumes) | drain Kafka before upgrading |
| DB schema | per-service Flyway migrators apply only not-yet-applied migrations | automatic |
| `db/full-dump.sql` (fast path) | loaded ONLY when PGDATA is empty | - |
| MDMS (roles, actions, masters) for an EXISTING tenant | bootstrap copies missing records from the `pg` tenant *already in the DB* (old copy) - so new-release records do NOT arrive | must be added by the operator (Phase 7) |
| Localization | bootstrap upserts default messages for the same key/locale -> customised texts in those locales revert | export before, re-apply after |
| `bootstrap_user` (ADMIN) | password/mobile/roles reset to `bootstrap_password` (default `eGov@123`) | set `bootstrap_password` in host_vars |
| `/etc/nginx/sites-available/<domain>` | overwritten unless `nginx_preserve_vhost: true` | host_vars |

## Inputs (ask the operator; do not guess)

1. `DIGIT_DIR` - live deploy dir (default `/opt/digit`; `~/digit` on macOS).
2. `SRC_REPO` + `SRC_REF` - the checkout and branch/commit the box was deployed from.
3. `TENANT` - the host_vars name used with deploy.sh (`inventory/host_vars/<TENANT>.yml`).
4. `TARGET_REF` - the new release (upstream tag/branch, e.g. the v2.12 release) and,
   if available, a plain checkout of it (`TARGET_DIR`) for the MDMS gap report.
5. Upgrade path: **A** in place on this box, or **B** (preferred) copy the box to a
   second machine/VM, upgrade the copy, then switch.
6. State tenant code (`state_root` in host_vars).

## Restricted production boxes

Claude does not need to run on production. The `scripts/` folder is plain
bash/python3 + docker with no network access and no Claude dependency:
- Run Claude (this skill) on the COPY of production (upgrade path B) or a dev box.
- On production, an operator copies `scripts/` over and runs them by hand:
  `safety_check.sh` and `drift_scan.py` (read-only), `backup.sh`, then `deploy.sh`.
- Bring back only the script OUTPUT (file names, counts, OK/FAIL lines, the MDMS
  gap CSV - no PII, no secrets) for Claude to review. Never move backups,
  `.env`, `.openbao/` or DB dumps out of the restricted zone.

## Procedure

### Phase 1 - Inventory: what is on the box that is not in git (read-only)

```bash
python3 -I .claude/skills/digit-upgrade/scripts/drift_scan.py --live "$DIGIT_DIR" --repo "$SRC_REPO"
```

The repo must be checked out at `SRC_REF`. If many files differ, also try other
local branches (`git for-each-ref refs/heads`) - the box may have been deployed
from a different branch or from uncommitted changes. The box itself is the
source of truth.

For each `CHANGED` / `ONLY ON SERVER` file, show the operator the diff (redact
secrets) and classify each hunk:
- **deploy rewrite** (tenant code `pg`->state_root, domain, mobile regex/country) - ignore;
- **hand edit** - must be saved to git (Phase 5);
- **stale** (server older than repo) - ignore.

Also compare live `.env` image pins (`*_IMAGE=` lines only) with host_vars `*_image`
keys and report mismatches. The operator decides which version is correct.

### Phase 2 - Safety check (read-only)

```bash
bash .claude/skills/digit-upgrade/scripts/safety_check.sh "$DIGIT_DIR" "$SRC_REPO/local-setup/ansible/inventory/host_vars/$TENANT.yml"
```

Report every `FAIL` / `WARN` line. Key rule it enforces: `db_fast_path` must equal
what the box ALREADY runs (postgres named volume at `/var/lib/postgresql/data`
=> `true`; flipping either way can make the DB look empty).

### Phase 3 - Release notes and data gap (read-only)

1. Read the target release's `docs/<version>/migration-guide-*.md`,
   `release-notes-*.md`, `known_issues_*.md`. Extract every "Action required" item
   and check each against the live DB (e.g. old-vs-new masters still present,
   required MDMS rows exist, `default: true` flags).
2. MDMS gap report (what the new release ships in its demo tenant that the live
   tenant lacks):
   ```bash
   python3 -I .claude/skills/digit-upgrade/scripts/mdms_gap.py \
     --dump "$TARGET_DIR/local-setup/db/full-dump.sql" --tenant "$STATE_ROOT" \
     --out ~/digit-upgrade-mdms-gap.csv
   ```
   Hand the CSV to the operator for review. Some gaps are intentional (tenant
   uses its own roles) - never auto-insert.
3. List customised localization keys that will revert:
   ```sql
   select m.locale, m.code, m.message, s.message from message m join message s
     on s.tenantid in ('pg','statea','statea.g','pg.citest','ke','ke.nairobi')
    and s.locale=m.locale and s.module=m.module and s.code=m.code and s.message<>m.message
   where m.tenantid='<state_root>' and m.code not like 'SERVICEDEFS.%';
   ```

Summarise Phases 1-3 to the operator in plain words before going further.

### Phase 4 - Backup (ASK first: needs a maintenance window)

1. Announce downtime; stop new traffic; wait for Kafka consumers to drain
   (`docker exec digit-redpanda rpk group list` / `describe` - lag 0).
2. ```bash
   bash .claude/skills/digit-upgrade/scripts/backup.sh "$DIGIT_DIR" ~/digit-backup-$(date +%F-%H%M)
   ```
   It takes `pg_dumpall`, a localization export, a tar of `DIGIT_DIR` (incl.
   `.openbao/`), a copy of host_vars and `/etc/nginx`, image tags of every
   container, and - after it stops the stack - a tarball of each named volume.
3. Verify: restore `pg_dumpall.sql` into a throwaway `postgres:<same major>`
   container and compare row counts of a few key tables.
4. Tell the operator to copy `.openbao/init.json` OFF the box.

### Phase 5 - Prepare the code (ASK first)

In `SRC_REPO`:
```bash
git checkout "$SRC_REF" && git checkout -b upgrade-<version>
```
1. Save every hand edit from Phase 1:
   - compose changes -> `local-setup/docker-compose.<TENANT>.yml` (only the
     changed keys, under `services: <name>: environment:`); secrets -> `.env`
     via host_vars/OpenBao, never compose defaults;
   - kong / other synced files -> commit in the branch;
   - settings -> `host_vars/<TENANT>.yml`.
   Commit: "Save server-only changes".
2. Merge the release: `git remote add upstream <official repo>` (if missing),
   `git fetch upstream --tags`, `git merge <TARGET_REF>`. On conflicts keep BOTH
   the release's new lines and the operator's lines; show each conflict to the
   operator.
3. Diff the merged tree against `TARGET_DIR` (if present) to confirm no release
   change was dropped.
4. Update `host_vars/<TENANT>.yml` against the new `_example.yml`: new keys,
   image pins, `bootstrap_password`, keep `db_fast_path` as Phase 2 said,
   `force_clean: false`.
5. Download the OTEL agent: `local-setup/otel/download-agent.sh`.
6. Dry run: `./deploy.sh <TENANT> --check --diff` and review.

### Phase 5b - Access control BEFORE the deploy (ASK first)

From v2.12.1 Kong enforces action-level RBAC on every protected call. An
existing tenant never receives the release's new actions/links from the deploy
(see table above), so without this step the deploy's own tenant bootstrap and
notification seed get 403s, and admins cannot save MDMS in the Configurator.
Old releases don't enforce RBAC in Kong, so adding records early is harmless.

1. Every role the deploy gives `bootstrap_user` must exist in the tenant's
   ACCESSCONTROL-ROLES (v2.12.1 adds ACCOUNT_ADMIN) — else the ADMIN re-provision
   fails with "Unable to validate role from MDMS". Add missing ones via MDMS v2 `_create`.
2. ```bash
   python3 -I .claude/skills/digit-upgrade/scripts/sync_accesscontrol.py \
     --dump "$TARGET_DIR/local-setup/db/full-dump.sql" --tenant "$STATE_ROOT"          # dry run
   ... --apply --log ~/accesscontrol-sync-$STATE_ROOT.jsonl                            # after review
   ```
   Create-only; matches by url / (role, url); keeps tenant ids. Tenant-custom roles
   (e.g. CMS_*) get nothing — the team decides those.
3. Tenant-only fixes with `scripts/fix_access.py` (dry run, then `--apply`): `--grant URL=ROLES`
   for the tenant's own endpoints the release data does not register (MOZ: `_admin/_search`,
   `_chronology`, `employee/_context` — Kong 403s them otherwise), and `--migrate-dashboard`
   with one `--tier ROLESET=officer|reports|reports-extended` per beta role set: v2.12.1 only
   honours the built-in tiers, and tiles without `requiredActionUrl` are hidden from everyone.
4. `docker restart egov-accesscontrol`. After any role change for a user, log the
   user out (`/user/_logout`) — egov-user reuses the live token with the OLD roles.

### Phase 6 - Deploy (ASK first)

Path B: restore the Phase 4 volumes + `DIGIT_DIR` on the copy machine first, run
there, validate (Phase 8), then repeat on production or switch traffic.

```bash
cd local-setup/ansible && ./deploy.sh <TENANT>
```
Follow `tail -f $DIGIT_DIR/digit-stack-up.<TENANT>.progress`. On any data-guard
abort: STOP, report, do not bypass.

### Phase 7 - Post-deploy data (ASK before each write)

1. All migrators exited 0: `docker ps -a --filter name=migration --format '{{.Names}} {{.Status}}'`;
   no `success = false` rows in any `*_schema` history table.
2. Apply the reviewed MDMS gap items via MDMS v2 `_create` (create-only) or the Configurator.
3. Re-apply the localization keys from Phase 3.3.
4. Reset `bootstrap_user` mobile/roles if the operator relies on them.
5. Do every manual item from the release migration guide.

### Phase 8 - Validate

```bash
bash .claude/skills/digit-upgrade/scripts/safety_check.sh "$DIGIT_DIR" <host_vars>   # again
```
Then check, and report pass/fail for each:
- all containers healthy; row counts match the backup (complaints, users, MDMS per schema);
- an existing user logs in and their decrypted mobile shows (encryption keys intact);
- OTP: a WRONG code is rejected (no mock route active);
- complaint create -> assign -> resolve -> escalate; notification delivered;
- inbox + dashboard show data; file upload/download works;
- live `kong/kong.yml` and overlay match the branch; `.openbao/init.json` matches the off-box copy.

### Rollback

Migrations are forward-only: roll back by RESTORING, not by older images.
Stop the stack -> restore volume tarballs + `DIGIT_DIR` tar -> `docker compose ... up -d`
with the recorded image tags (from `containers-inspect.json`), without re-running the
new deploy.sh. Data entered after cutover is lost - agree a go/no-go time first.

## Afterwards (so the next upgrade is easy)

Tell the operator: never edit `DIGIT_DIR` by hand again - every change goes into
host_vars, the tenant overlay, or the branch. Then the next upgrade is just
"merge the release, run deploy.sh, run this skill's checks".
