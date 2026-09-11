# UPSTREAM-BASELINE.md

**DIGIT Complaint Management System — Mozambique**
Release `cms-mozambique-v1.0.0` · release commit `124678e55b6f59aeba61bae753e6b00ef842dfb7`

---

## 0. What this document is

This is the **permanent provenance record** for the Mozambique CMS v1.0.0 release. It answers, for anyone reading it years from now:

- Which upstream product does this fork descend from, and *at exactly which commit*?
- What is genuinely fork-local versus what merely *mirrors* upstream work?
- What upstream work exists but is **not** in this release?
- How do I reproduce every number in this document myself, from the repositories, without trusting this file?

Every claim below is either (a) a commit SHA / file path you can check out, or (b) a git command with its expected output. Where something could not be established from the repositories it is written as **NOT VERIFIED** — treat those as open questions, not as facts.

`cms-mozambique-v1.0.0` is a **documentation release**. It introduces no application code change. Its entire purpose is to freeze, name and describe a code state that already exists and has been running on the pilot environment. This baseline record is one of its deliverables.

---

## 1. Identity of the two repositories

| Role | Repository | Branch of record | Commit of record |
|---|---|---|---|
| **Fork (this release)** | `eGov-Global/CMS-MOZAMBIQUE` | `master` | `124678e55b6f59aeba61bae753e6b00ef842dfb7` — *"Create stateige.yml.example (#3)"*, pradeep-egov, 2026-08-14 12:13:24 +0530 |
| **Upstream product** | `egovernments/Citizen-Complaint-Resolution-System` | `release-v2.12-moz` | `343617ceab56b28ced9ad276286d9afc0ef613a8` — *"Merge pull request #1757 from egovernments/merge/master-into-moz-1756"*, Hari-egov, 2026-08-14 10:49:21 +0530 |

Release identifier: the **annotated tag `cms-mozambique-v1.0.0`** on the fork, pointing at `124678e5`. It is *not* a plain `v1.0.0`; do not abbreviate it, because the fork also carries upstream's own tags (`CCRS-2.10`, `v2.11`, `v2.12-beta`) and a bare `v1.0.0` would be ambiguous against them.

> **Fetch note.** A clone that was last fetched before the tag was pushed will not show it. `git fetch --tags origin` first, then `git rev-list -n 1 cms-mozambique-v1.0.0` must print `124678e55b6f59aeba61bae753e6b00ef842dfb7`. In the working clone used to produce this document, `git tag -l` listed only `CCRS-2.10`, `v2.11`, `v2.12-beta`, i.e. the release tag had not yet been fetched into that clone — **whether it is already pushed to `origin` at the time you read this is NOT VERIFIED**; the command above is the authoritative check.

Remote layout assumed by every command in this document (as configured in the reference clone `/home/user/Documents/CCRS/CMS-MOZAMBIQUE`):

```
origin    https://github.com/eGov-Global/CMS-MOZAMBIQUE.git
upstream  https://github.com/egovernments/Citizen-Complaint-Resolution-System.git
```

Set it up on a fresh machine with:

```bash
git clone https://github.com/eGov-Global/CMS-MOZAMBIQUE.git
cd CMS-MOZAMBIQUE
git remote add upstream https://github.com/egovernments/Citizen-Complaint-Resolution-System.git
git fetch --all --tags
```

All SHAs quoted here are reachable from **either** repository once `upstream` is fetched, because the fork's history contains upstream's history.

---

## 2. The baseline commit, and why it is that commit

**Baseline = `343617ce` on `egovernments/Citizen-Complaint-Resolution-System`, branch `release-v2.12-moz`.**

The baseline is defined as *the newest upstream commit that is fully contained in the release commit*. It is not chosen by date, by tag, or by release-note headline — it is chosen because the diff from it to the release commit is small, fully enumerable, and provably free of application code.

### 2.1 The two-file proof

```bash
git diff --stat 343617ceab56b28ced9ad276286d9afc0ef613a8 124678e55b6f59aeba61bae753e6b00ef842dfb7
```

```
 .github/CODEOWNERS                                 |   3 +
 .../inventory/host_vars/stateige.yml.example       | 290 +++++++++++++++++++++
 2 files changed, 293 insertions(+)
```

Exactly **2 files changed, +293 insertions, −0 deletions**. Both files are non-runtime:

| File | Nature |
|---|---|
| `.github/CODEOWNERS` | GitHub review routing for protected branches. Never shipped, never executed. |
| `local-setup/ansible/inventory/host_vars/stateige.yml.example` | An **example** Ansible inventory file for a new host. `*.example` files are templates an operator copies and edits; the deployment reads `host_vars/<tenant>.yml`, not `.example`. Any credentials inside it are example/test defaults that **MUST be changed** before use. |

This is what makes the "documentation release, no application code change" claim checkable in one command rather than asserted. Zero deletions and zero touched service, frontend, migration or compose files means the deployable artifact set of `124678e5` is byte-for-byte the deployable artifact set of `343617ce`.

> **Known defect in the added example file (carried into the release, not fixed by it):** `stateige.yml.example` still carries the header of the file it was copied from (`bomet.yml.example`, referencing `deploy.sh bomet`) and sets `domain: localhost`. It is stale and misleading as an example header. Cosmetic, but it will confuse the next operator.

### 2.2 The four fork-local commits

```bash
git log --format='%h %ad %an | %s' --date=short 343617ce..124678e5
```

```
124678e5 2026-08-14 pradeep-egov     | Create stateige.yml.example (#3)
d91c301c 2026-08-14 Shivam Upadhyay  | Merge branch 'egovernments:release-v2.12-moz' into release-v2.12-moz
a52d35d8 2026-08-13 Shivam Upadhyay  | Merge branch 'egovernments:release-v2.12-moz' into release-v2.12-moz
41727cc3 2026-08-12 Shivam Upadhyay  | chore: set CODEOWNERS for protected-branch review enforcement
```

Four commits, of which two are merges that pull upstream *in* (they contribute no fork-authored content) and two add the two files above. **This is the entire set of changes that originated in the fork.** Everything else in the fork came from upstream.

---

## 3. Upstream master containment

The release contains upstream's mainline product up to:

**`815b23747a6064736a5449cd2ecf7aae81b0c567`** — *"Merge pull request #1751 from KDwevedi/fix/1108-dashboard-localization-closure"*, vinothrallapalli-eGov, 2026-08-13 17:01:58 +0530.

```bash
git merge-base --is-ancestor 815b23747a6064736a5449cd2ecf7aae81b0c567 124678e5 && echo "contained"
# → contained
```

This is the commit used as the **product-master reference point** for the "what did Mozambique customize" delta in §5. Any upstream master work merged after `815b2374` is, by definition, not in this release.

---

## 4. Current upstream tip and the divergence

At the time this record was written, the upstream branch `release-v2.12-moz` had advanced to:

**`b55c8533a7e48d97045742188308ab4da81a97b9`** — *"Merge pull request #1764 from egovernments/feat/moz-2171-boundary-path-param"*, Hari-egov, 2026-08-14 13:41:28 +0530.

```bash
git rev-list --left-right --count 124678e5...b55c8533a7e48d97045742188308ab4da81a97b9
# → 4    9
```

**4 ahead / 9 behind. The fork and upstream have DIVERGED.**

Consequences, stated plainly:

- **A fast-forward resync is not possible.** `git merge --ff-only upstream/release-v2.12-moz` will refuse.
- **`git reset --hard upstream/release-v2.12-moz` would destroy the release.** It discards the 4 fork-local commits and therefore deletes `.github/CODEOWNERS` and `local-setup/ansible/inventory/host_vars/stateige.yml.example` — the only two files that are actually fork-original. Do not do this on `master`.
- The correct future operation is a **merge** (or a rebase of the 4 commits onto the new upstream tip), performed as a deliberate, reviewed, post-v1.0.0 activity — not as part of this release.

**Why the divergence was not resolved before releasing:** the 9 upstream commits landed *after* the fork's last sync (`d91c301c`, 2026-08-14). This release deliberately ships the code that was analysed, reviewed and pilot-verified, exactly as it stands. Pulling 9 unverified commits in at tag time would have invalidated that verification. Upstream sync is tracked as separate work after v1.0.0.

---

## 5. The three delta framings — keep them distinct

This is the single most misread part of the fork's history. There are **three different, all-true, wildly different-sized** answers to "how much was changed", and quoting the wrong one produces a badly wrong impression of the work.

### Framing A — Fork-local delta (what the fork itself authored)

`343617ce..124678e5` → **4 commits · 2 files · +293 / −0**

This is the honest answer to *"what code exists only in `eGov-Global/CMS-MOZAMBIQUE` and nowhere upstream?"* Answer: a CODEOWNERS file and an example inventory file. **No application code.**

### Framing B — Mozambique product customization vs. upstream product master

`815b2374...124678e5` → **556 commits · 256 files · +31,277 / −2,288**

```bash
git diff --shortstat 815b23747a6064736a5449cd2ecf7aae81b0c567...124678e5
# → 256 files changed, 31277 insertions(+), 2288 deletions(-)
git rev-list --count 815b23747a6064736a5449cd2ecf7aae81b0c567..124678e5
# → 556
```

This is the honest answer to *"how much does the Mozambique product differ from the generic upstream product?"* It is the number that matters for effort, for review scope, and for understanding the deployed system. Of these, **118 changes are classified as in-release customizations and 74 are production-critical** (see the classification artifacts accompanying this release).

Where the 256 files sit (`git diff --numstat 815b2374...124678e5`, aggregated by top-level directory):

| Area | Files | +/− |
|---|---:|---|
| `digit-ui-esbuild` (THE deployed frontend, served at `/digit-ui`) | 124 | +9,753 / −1,100 |
| `configurator` (DIGIT Studio, active for Mozambique) | 49 | +3,475 / −45 |
| `utilities` (incl. `docs/migration` tooling companions, default-data-handler, otp-publisher) | 24 | +8,691 / −1,074 |
| `docs` (runbooks, migration runner + seed data) | 23 | +7,706 / −5 |
| `backend` (pgr-services and friends) | 18 | +847 / −54 |
| `local-setup` (Ansible + Docker Compose deployment) | 16 | +800 / −9 |
| root files | 2 | +5 / −1 |
| **Total** | **256** | **+31,277 / −2,288** |

Note the shape: the customization is overwhelmingly **frontend, configuration and seed data**, with a comparatively small backend surface.

### Framing C — Where framing B's commits were actually authored

**552 of the 556 commits were authored, reviewed and merged INSIDE the upstream repository, on branch `release-v2.12-moz`. The fork MIRRORS them.**

```bash
comm -12 <(git rev-list 815b2374..124678e5 | sort) \
         <(git rev-list 815b2374..b55c8533 | sort) | wc -l
# → 552
```

556 − 552 = 4, which is exactly framing A.

> ### ⚠️ Conflation warning
>
> - Do **not** say "the fork changed 256 files / 31k lines." It did not. **Upstream** did, on the `release-v2.12-moz` branch; the fork mirrors that branch and adds two non-runtime files.
> - Do **not** say "the fork is only 293 lines of change, so the Mozambique product is nearly stock upstream." It is not. The Mozambique product diverges from upstream master by 556 commits.
> - The precise sentence that is true and complete: **"Mozambique customization = 556 commits vs. upstream master, of which 552 live upstream on `release-v2.12-moz`; the fork adds 4 commits containing 2 non-runtime files."**

### 5.1 Authorship and date span of the 556

```bash
git log --format='%an' 815b23747a6064736a5449cd2ecf7aae81b0c567..124678e5 | sort | uniq -c | sort -rn
```

| Author | Commits |
|---|---:|
| Hari-egov | 481 (86.5%) |
| pradeep-egov | 22 |
| nozotrox | 19 |
| priyanshu-egov | 11 |
| Admin | 11 |
| subhashini-egov | 6 |
| Shivam Upadhyay | 3 |
| vinothrallapalli-egov | 1 |
| Subhashini Srinivasan | 1 |
| Feliciano Mazoio | 1 |

(Counts include merge commits, which is why they exceed a `--no-merges` shortlog. `Admin` and the two single-commit identities appear to be un-normalised git identities; author-identity mapping is **NOT VERIFIED**.)

Date span: **2026-06-12 … 2026-08-14** — June 31 commits, July 454, August 71.

### 5.2 Zero database migrations in the delta

```bash
git diff --name-only 815b23747a6064736a5449cd2ecf7aae81b0c567...124678e5 -- '*.sql'
# → (no output)
```

**There are no Mozambique-specific database migrations.** All 22 Flyway migrations in the tree are byte-identical to upstream. This is load-bearing for release engineering: there is no Moz-specific schema step for a fresh install or an upgrade, and nothing schema-related blocks an image rollback. (Separate rollback caveats — no down-migrations anywhere, no version/checksum state in the MDMS seeding layer, a non-concurrent `REFRESH MATERIALIZED VIEW` of unmeasured production duration — are documented in the release notes and migration guide, not here.)

---

## 6. The 9 upstream commits NOT in this release

These exist upstream on `release-v2.12-moz` between the baseline and the current upstream tip. **They are not in `cms-mozambique-v1.0.0`. Their features must not be described as included in it.**

```bash
git log --oneline --no-decorate 343617ce..b55c8533a7e48d97045742188308ab4da81a97b9
```

| # | SHA | Date | Subject | Ticket |
|---:|---|---|---|---|
| 1 | `6c19c0c1` | 2026-08-13 | `fix(migration): register CMS_ADMIN + CMS_DASHBOARD_VIEWER in the --cms phase` | CCSD-1937 |
| 2 | `3ea00efc` | 2026-08-13 | `fix(migration): also register CONFIDENTIAL_COMPLAINT_VIEWER in --cms` | CCSD-1937 |
| 3 | `6e9f1fe5` | 2026-08-13 | `feat(deploy): seed CMS roles/grants/workflow during the deploy itself` | CCSD-1937 |
| 4 | `a697917d` | 2026-08-14 | `Merge pull request #1753 from egovernments/fix/moz-1937-cms-admin-role` | CCSD-1937 |
| 5 | `1dfc82cd` | 2026-08-14 | `feat(analytics): boundaryPath subtree param for the geography drill-down` | CCSD-2171 |
| 6 | `45ee087a` | 2026-08-14 | `feat(dashboard): geography drill-down filter — Província → Distrito → Município` | CCSD-2171 |
| 7 | `943c42de` | 2026-08-14 | `Merge pull request #1762 from egovernments/feat/moz-2171-boundary-path-param` | CCSD-2171 |
| 8 | `1f082e60` | 2026-08-14 | `Merge pull request #1763 from egovernments/feat/moz-2171-geography-drilldown` | CCSD-2171 |
| 9 | `b55c8533` | 2026-08-14 | `Merge pull request #1764 from egovernments/feat/moz-2171-boundary-path-param` | CCSD-2171 |

### 6.1 Operational consequences of their absence

**CCSD-1937 (commits 1–4) — role registration and deploy-time seeding.**

- This release's `docs/migration/ccrs-migrate.cjs` registers **only 5** CMS roles: `CMS_RECEPTION_OFFICER`, `CMS_SCREENING_OFFICER`, `CMS_SUPERVISOR`, `CMS_CASE_MANAGER`, `CMS_VIEWER`.
- The seed files contain **7** `CMS_*` roles. `CMS_ADMIN`, `CMS_DASHBOARD_VIEWER` and `CONFIDENTIAL_COMPLAINT_VIEWER` are **not auto-registered by this release**, even though features that depend on them *are* shipped. **These three must be registered manually** on every environment.
- Deploy-time CMS seeding (commit 3) is likewise absent, so `node docs/migration/ccrs-migrate.cjs --only cms` is a **manual post-deploy step** for v1.0.0, not something the Ansible playbook performs.

**CCSD-2171 (commits 5–9) — geography drill-down.**

- The analytics `boundaryPath` subtree parameter and the dashboard Província → Distrito → Município drill-down filter are **not in this release**. Do not demo, document or promise them against `cms-mozambique-v1.0.0`.

Both feature sets are candidates for the first post-v1.0.0 sync.

---

## 7. Why a tag must NOT be used as the baseline

A natural instinct is to record the baseline as "upstream tag `v2.12-beta`". **That would be wrong twice over.**

### 7.1 The tag was force-moved

`v2.12-beta` previously pointed at `8c7c4fe6d0bed4470be7c37605ad87f5cdbf498c` (*"Merge pull request #1580 from egovernments/docs/release-notes-v2.12-beta"*, 2026-08-05 16:19) and now resolves to `5f86a10264280735984c661df2de0d1bc9a708a8` (*"Merge pull request #1599 from egovernments/docs/2.12-beta-release-folder"*, 2026-08-05 17:27). The tag name is therefore **not a stable identifier** of a tree: two clones fetched an hour apart can disagree about what `v2.12-beta` means, and a clone that fetched the old value will silently keep it (git does not clobber existing tags without `--force`/`--tags -f`).

```bash
git ls-remote --tags upstream | grep v2.12-beta
# 73ffed05...  refs/tags/v2.12-beta        (the annotated tag object)
# 5f86a102...  refs/tags/v2.12-beta^{}     (what it dereferences to TODAY)
```

Note this also violates upstream's own stated policy (`docs/rapid-release-approach.md` §4: tags are immutable and are the unit of deployment) — which is precisely why a downstream record must pin to a commit SHA and not trust the tag.

### 7.2 The tag contains none of the Mozambique work anyway

```bash
comm -12 <(git rev-list 815b2374..124678e5 | sort) <(git rev-list 815b2374..5f86a102 | sort) | wc -l
# → 0
git rev-list --count 815b23747a6064736a5449cd2ecf7aae81b0c567..5f86a102
# → 0
```

`5f86a102` is an ancestor of upstream master `815b2374` and shares **zero** of the 556 Mozambique-line commits. Using it as "the baseline" would misreport the entire Mozambique delta.

**Rule for this repository: baselines are recorded as full 40-character commit SHAs. Never as tag names, never as branch names, never as dates.**

---

## 8. Architectural context a reader needs to interpret the delta

Enough context that the file counts in §5 are not misleading:

- **Only ~7 first-party backend services exist in this tree**: `pgr-services`, `digit-config-service`, `novu-bridge`, `novu-bridge-endpoint`, `novu-dashboard`, `digit-user-preferences-service`, `xstate-chatbot`, plus `utilities/default-data-handler`, `utilities/otp-publisher`, `digit-mcp`, `turbopass/search-api`. **Every other DIGIT service is a prebuilt `egovio/*` image with no source in-tree.** A small `backend/` delta therefore does not mean "the backend was barely touched" — it means most of the backend is not in this repository at all.
- Java services: **Java 17, Spring Boot 3.2.2** (`pgr-services` 3.0.0).
- **`digit-ui-esbuild` is THE product frontend** (esbuild React 17 SPA served at `/digit-ui`). `digit-ui-v2` and `frontend/micro-ui` are **legacy and not deployed** — changes there do not reach users. `configurator` (DIGIT Studio) **is** active for Mozambique.
- Deployment is **single-host Docker Compose driven by Ansible**: `local-setup/ansible/deploy.sh <tenant>` → `playbook-deploy.yml` → `local-setup/docker-compose.egov-digit.yaml` (+ overlays: migrations, monitoring, fast-path), fronted by Kong, health-checked by Gatus. Hence `local-setup/` changes are deployment-behaviour changes, not scaffolding.
- Upstream release-doc convention (followed by this release): `docs/<version>/release-notes-v<version>.md`, `migration-guide-v<prev>-to-v<version>.md`, `release-config-changelog-v<version>.md`. There is **no root `CHANGELOG.md`**; per-service `CHANGELOG.md` files exist.

---

## 9. Reproduction cookbook

Run from a clone of the fork with `upstream` added and `git fetch --all --tags` done. Copy-paste verbatim; expected output is given for each.

```bash
# --- 0. Pin the identifiers as shell vars -------------------------------------
REL=124678e55b6f59aeba61bae753e6b00ef842dfb7          # release commit (fork master)
BASE=343617ceab56b28ced9ad276286d9afc0ef613a8         # upstream baseline (release-v2.12-moz)
UPMASTER=815b23747a6064736a5449cd2ecf7aae81b0c567     # upstream master containment point
UPTIP=b55c8533a7e48d97045742188308ab4da81a97b9        # upstream release-v2.12-moz tip at record time

# --- 1. The release tag resolves to the release commit ------------------------
git rev-list -n 1 cms-mozambique-v1.0.0
# → 124678e55b6f59aeba61bae753e6b00ef842dfb7
git cat-file -t cms-mozambique-v1.0.0
# → tag        (annotated, not lightweight)

# --- 2. Baseline proof: 2 files, +293, no application code --------------------
git diff --stat $BASE $REL
# → 2 files changed, 293 insertions(+)
git diff --name-only $BASE $REL
# → .github/CODEOWNERS
#   local-setup/ansible/inventory/host_vars/stateige.yml.example

# --- 3. The 4 fork-local commits ---------------------------------------------
git log --format='%h %ad %an | %s' --date=short $BASE..$REL
# → 4 lines (124678e5, d91c301c, a52d35d8, 41727cc3)

# --- 4. Upstream master containment ------------------------------------------
git merge-base --is-ancestor $UPMASTER $REL && echo contained
# → contained

# --- 5. Divergence: 4 ahead / 9 behind ---------------------------------------
git rev-list --left-right --count $REL...$UPTIP
# → 4    9
git merge-base --is-ancestor $UPTIP $REL || echo "NOT fast-forwardable"
# → NOT fast-forwardable

# --- 6. The 9 excluded commits ------------------------------------------------
git log --oneline --no-decorate $BASE..$UPTIP
# → 9 lines (see §6 table)

# --- 7. Framing B: Mozambique customization vs upstream master ----------------
git rev-list --count $UPMASTER..$REL          # → 556
git diff --shortstat $UPMASTER...$REL         # → 256 files changed, 31277 insertions(+), 2288 deletions(-)

# --- 8. Framing C: 552 of the 556 are mirrored from upstream ------------------
comm -12 <(git rev-list $UPMASTER..$REL | sort) <(git rev-list $UPMASTER..$UPTIP | sort) | wc -l
# → 552

# --- 9. Zero Mozambique SQL migrations ---------------------------------------
git diff --name-only $UPMASTER...$REL -- '*.sql'
# → (empty)

# --- 10. Tag force-move evidence ---------------------------------------------
git ls-remote --tags upstream | grep 'v2.12-beta'
# → 73ffed05... refs/tags/v2.12-beta ; 5f86a102... refs/tags/v2.12-beta^{}
git log --oneline -1 8c7c4fe6   # the PREVIOUS target of the same tag name
git log --oneline -1 5f86a102   # the CURRENT target
git rev-list --count $UPMASTER..5f86a102
# → 0        (tag target sits inside upstream master; zero moz-line commits)

# --- 11. Authorship of the 556 -----------------------------------------------
git log --format='%an' $UPMASTER..$REL | sort | uniq -c | sort -rn
```

If any command above disagrees with this document, **the repository wins** — the numbers here were captured at tag time and upstream branches keep moving. Only `$REL` and `$BASE` are immutable anchors; `$UPTIP` is a snapshot.

---

## 10. Repository hygiene observed at tag time

Recorded so a future reader does not mistake these for corruption or for release blockers.

| Observation | Detail | Status |
|---|---|---|
| `develop` diverged from `master` | `git rev-list --left-right --count origin/master...origin/develop` → `1 2` (develop 2 ahead / 1 behind). **But `git diff origin/master origin/develop` is empty — the trees are identical.** Pure history duplication of `stateige.yml.example`. | Technical debt. **Not a release blocker.** |
| Stale example header | `stateige.yml.example` retains `bomet.yml.example`'s header (`deploy.sh bomet`) and `domain: localhost`. | Cosmetic defect, shipped. |
| Example credentials | The `.example` inventory contains example/test defaults that **MUST be changed** before any real deployment. No secret values are reproduced in this document. | Operator action required. |
| Test coverage | Across all 556 commits: **1 test added, 2 modified** (`configurator/src/providers/resolveInitialLocale.test.ts` added; `PGRServiceCountScopingTest.java` and `configurator/.../dataProvider.test.ts` modified). No automated coverage for workflow transitions, notifications, extended attributes, roles/permissions or localization. | **Largest release-readiness gap.** Tracked in the release notes. |
| `PGR_WORKFLOW_VARIANT` | No longer set anywhere after `default-data-handler` was removed from the compose stack. | **NOT VERIFIED** — must be checked on a real environment. |

Security and functional limitations of the release itself (including the unauthenticated `POST /pgr-services/v2/request/_admin/_search` admin search, proven on `cms-pilot` with a `CMS_SCREENING_OFFICER`-only user receiving HTTP 200) are documented in the release notes, not here. This file is provenance only.

---

## 11. Guidance for the next sync (post-v1.0.0)

Not part of this release; recorded so the next engineer does not have to rediscover the constraints.

1. **Never `reset --hard`** the fork's `master` onto upstream. It deletes `.github/CODEOWNERS` and `local-setup/ansible/inventory/host_vars/stateige.yml.example`, the only two fork-original files. Merge, or rebase the 4 commits.
2. **Sync on a branch, not on `master`**; tag only after the merged state has been verified on an environment, the same way `124678e5` was.
3. **Expect the 9 commits of §6 first.** Bringing in CCSD-1937 removes limitation §6.1 (manual registration of `CMS_ADMIN`, `CMS_DASHBOARD_VIEWER`, `CONFIDENTIAL_COMPLAINT_VIEWER`, and the manual `--only cms` post-deploy step). Bringing in CCSD-2171 adds the geography drill-down.
4. **Re-check for `*.sql` changes** with the §9 step 9 command after every sync. The "zero Moz-specific migrations" property is valuable — losing it silently would change rollback semantics (upstream policy `docs/rapid-release-approach.md` §6: image rollback is only safe while migrations remain backward-compatible / expand-contract; a destructive migration forces roll-forward-only and must be stated in release notes).
5. **Record the new baseline the same way**: a full SHA, a `git diff --stat` proof, and an explicit list of what was left behind. Append to this file; do not overwrite its history.

---

## 12. Provenance summary (one table)

| Fact | Value | Verify with |
|---|---|---|
| Release tag | `cms-mozambique-v1.0.0` (annotated) | `git cat-file -t cms-mozambique-v1.0.0` |
| Release commit | `124678e55b6f59aeba61bae753e6b00ef842dfb7` | `git rev-list -n 1 cms-mozambique-v1.0.0` |
| Upstream repo | `egovernments/Citizen-Complaint-Resolution-System` | `git remote -v` |
| Upstream baseline | `343617ceab56b28ced9ad276286d9afc0ef613a8` (`release-v2.12-moz`) | `git diff --stat 343617ce 124678e5` |
| Baseline proof | 2 files, +293, −0, no application code | same command |
| Upstream master contained to | `815b23747a6064736a5449cd2ecf7aae81b0c567` | `git merge-base --is-ancestor 815b2374 124678e5` |
| Upstream tip at record time | `b55c8533a7e48d97045742188308ab4da81a97b9` | `git rev-parse upstream/release-v2.12-moz` |
| Divergence | 4 ahead / 9 behind — **not fast-forwardable** | `git rev-list --left-right --count 124678e5...b55c8533` |
| Fork-local delta | 4 commits · 2 files · +293 | §5 framing A |
| Moz customization vs upstream master | 556 commits · 256 files · +31,277 / −2,288 | §5 framing B |
| Mirrored from upstream | 552 of 556 | §5 framing C |
| Moz-specific SQL migrations | **0** | `git diff --name-only 815b2374...124678e5 -- '*.sql'` |
| Baseline may be a tag? | **No** — `v2.12-beta` force-moved `8c7c4fe6` → `5f86a102`, and contains 0 moz-line commits | §7 |

*End of upstream baseline record for `cms-mozambique-v1.0.0`.*