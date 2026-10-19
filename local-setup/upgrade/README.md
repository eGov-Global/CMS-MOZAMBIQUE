# Tenant upgrade driver

Generic form of the per-box upgrade runbooks. Runs **on the DIGIT server**,
against `/opt/digit` and the local docker daemon. Every tenant name, path,
container name, port and credential comes from a config file, so the same
script serves any tenant.

```bash
cd local-setup/upgrade
cp upgrade.conf.example upgrade.conf.<tenant>
$EDITOR upgrade.conf.<tenant>          # TENANT is the only required value

./upgrade.sh --config upgrade.conf.<tenant> --dry-run   # see the plan
./upgrade.sh --config upgrade.conf.<tenant>             # gated run
```

## Steps

| # | Step | Changes the box? |
|---|---|---|
| 1 | preflight — tools, paths, password, **host_vars traps** (`docker_data_root`, `digit_ui_v2_repo`, `secrets_path`, `locale_default`, Novu key, `bootstrap_password`) | no |
| 2 | safety check — Postgres location, OpenBao key unseals, `secrets_path` matches `.env`, failed migrations | no |
| 3 | drain — every Kafka consumer group at zero lag | no |
| 4 | backup — dumps, config tarballs, volume copies, then restart and **wait until an admin login works** | **stops the stack** |
| 5 | access control — bootstrap role + release actions and role links, verified | **writes MDMS** |
| 6 | deploy — `ansible/deploy.sh <tenant>` | **restarts everything** |
| 7 | post-deploy — session refresh, health, one-shot jobs, schema, 403s **since the deploy** | writes session only |
| 8 | smoke — wrong OTP refused, 401 without login, pages, virus-scan upload | uploads one test file |
| — | `--rollback DIR` — restore a step-4 backup and start the previous stack | **overwrites all data** |

Steps 4, 5, 6 and `--rollback` ask first. `--yes` answers for you; without it a
non-tty is a hard stop. `--dry-run` never asks and changes nothing.

Why this order: the v2.12.1 Kong refuses any call whose role lacks a matching
permission, and a deploy never adds the release's permissions to an existing
tenant — so they go in at step 5, before the new Kong starts checking.

## Flags

```
--config FILE     settings (see upgrade.conf.example)
--yes, -y         don't ask at the gated steps
--dry-run         print what would happen, change nothing
--from-step N     resume after a failure (with --backup-dir to keep the same backup)
--backup-dir DIR  reuse a backup directory from an earlier run
--rollback DIR    restore a step-4 backup and start the previous stack
--only N          run a single step
--list-steps
```

## Configuration

Precedence is **config file > environment > built-in default**: keys left
commented out in the file can be set from the environment for a one-off run:

```bash
PUBLIC_URL=https://uat.falacidadao.gov.mz ./upgrade.sh --config upgrade.conf.ige
```

`TENANT` is the ansible tenant (the `host_vars/<name>.yml` stem).
`STATE_TENANT` is the MDMS state tenant, which is often different — the `ige`
box deploys tenant `ige` but all its MDMS data lives under `mz`.

### Credentials

The admin password is never read from the config file by default. Either
export it, or point at a `0600` file:

```bash
printf '%s' 'the-password' > /root/.digit-admin-password
chmod 600 /root/.digit-admin-password
# ADMIN_PASSWORD_FILE=/root/.digit-admin-password in the config
```

At upgrade time this is still the pre-rotation password, because the deploy has
to log in as ADMIN before `bootstrap_password` is set in host_vars.

## What it deliberately does not do

Reported as follow-ups at the end rather than silently skipped:

- **Choosing or merging the release.** Step 1 only warns that uncommitted files
  will be deployed; which commit you deploy is yours to decide.
- **The escalation migration** — needs per-tenant MDMS decisions. See
  `docs/2.12/migration-guide-v2.12-to-v2.12.1.md` step 6a.
- **Credential rotation** — ADMIN's password, `bootstrap_password`, Novu and
  gateway secrets.
- **Restore what the backup does not hold:** web roots under `/var/www`, the
  host firewall (`ufw`), packages the deploy installed. `--rollback` lists them.

## Multi-node

Single node per run. For a load-balanced environment, run it on one node first,
then on the rest with `--from-step 6` so the one-time DB and MDMS work in steps
4–5 is not repeated. Config under `/opt/digit` must end up identical on every
node.

## Layout

```
upgrade.sh                 driver
upgrade.conf.example       documented settings template
lib/safety_check.sh        pre/post health probe
lib/backup.sh              dumps, config tarballs, volume copies
lib/sync_accesscontrol.py  v2.12.1 actions and role links
lib/add_role.py            bootstrap admin role
lib/refresh_session.py     force ADMIN's token to be re-issued
lib/digit_api.py           shared login helpers (stdlib only)
lib/smoke_upload.py        clean + EICAR upload through the virus-scan path
```
