# Gate 2 Release Checklist — CMS Mozambique v1.0.0

**Release:** `cms-mozambique-v1.0.0` · **Date:** 17 August 2026 · **Owner:** Hariprasad · **Reviewer:** Pradeep Kumar / Gurjeet Singh

Status values: **Yes** — complete · **Partially** — complete with a documented limitation · **No** — not done for this release, with the reason stated · **Not applicable** — does not apply to a first release.

| S.No. | Checklist | Yes/No/Partially | Reference Link | Owner | Reviewer | Remarks |
|---|---|---|---|---|---|---|
| 1 | Release scope agreed and documented | Yes | [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) | Hariprasad | Pradeep | Scope is the freeze of the UAT-validated implementation |
| 2 | Release version and tag defined | Yes | [Release](https://github.com/eGov-Global/CMS-MOZAMBIQUE/releases/tag/cms-mozambique-v1.0.0) | Hariprasad | Pradeep | Annotated tag `cms-mozambique-v1.0.0` |
| 3 | Upstream product baseline identified | Yes | [Upstream Baseline](UPSTREAM-BASELINE.md) | Hariprasad | Pradeep | Baseline recorded with exact commit and reproduction commands |
| 4 | Customizations documented against the product | Yes | [Customization Matrix](MOZAMBIQUE-CUSTOMIZATION-MATRIX.md) | Hariprasad | Gurjeet | 118 customizations, 74 production-critical, grouped by product area |
| 5 | Release notes prepared | Yes | [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) | Hariprasad | Pradeep | Follows the DIGIT release-notes structure |
| 6 | Changelog prepared | Yes | [Changelog](CHANGELOG.md) | Hariprasad | Pradeep | Separates product features from Mozambique additions and changes |
| 7 | Release manifest prepared | Yes | [Release Manifest](release-manifest.yml) | Hariprasad | Pradeep | Machine-readable; includes UAT status |
| 8 | Configuration and master data documented | Yes | [Configuration](CONFIGURATION.md) | Hariprasad | Pradeep | Separates product configuration from environment-specific values |
| 9 | Deployment steps documented | Yes | [Deployment](DEPLOYMENT.md) | Hariprasad | Pradeep | Includes prerequisites, sequence, health checks and rollback |
| 10 | Manual deployment steps identified | Yes | [Deployment](DEPLOYMENT.md) | Hariprasad | Pradeep | CMS seeding command and workflow service restart |
| 11 | Database changes identified | Yes | [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) | Hariprasad | Pradeep | No Mozambique database changes; all structures come from the product |
| 12 | Database rollback approach stated | Partially | [Deployment](DEPLOYMENT.md) | Hariprasad | Pradeep | No reverse migrations exist in the product; data rollback is restore-from-backup |
| 13 | Localization complete for supported languages | Yes | [Configuration](CONFIGURATION.md) | Hariprasad | Gurjeet | Portuguese and English packs for citizen and officer applications |
| 14 | Roles and permissions documented | Yes | [Configuration](CONFIGURATION.md) | Hariprasad | Pradeep | Role catalogue and grants listed |
| 15 | Workflow configuration documented | Yes | [Configuration](CONFIGURATION.md) | Hariprasad | Pradeep | States, actions and permitted roles listed |
| 16 | Notification configuration documented | Yes | [Configuration](CONFIGURATION.md) | Hariprasad | Pradeep | Routing rules and templates are configurable, not coded |
| 17 | UAT environment identified | Yes | [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) | Hariprasad | Gurjeet | cms-pilot.digit.org |
| 18 | Core citizen journeys validated | Yes | [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) | Gurjeet | Pradeep | Filing, tracking, reopening and rating exercised |
| 19 | Core officer journeys validated | Yes | [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) | Gurjeet | Pradeep | Assignment, send-back, resolution exercised |
| 20 | Notifications validated | Yes | [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) | Hariprasad | Gurjeet | Delivery confirmed in the notification log for four workflow stages |
| 21 | Attachments validated | Yes | [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) | Hariprasad | Gurjeet | All advertised formats upload and retrieve |
| 22 | Dashboard validated | Yes | [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) | Hariprasad | Gurjeet | Indicators, charts and map render with seeded data |
| 23 | Formal UAT sign-off recorded | No | — | Pradeep | Gurjeet | No sign-off record available in the repository; to be attached |
| 24 | Automated regression test suite | No | [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) | Hariprasad | Pradeep | Not available; validation is manual. Planned as separate work |
| 25 | Performance testing | No | — | — | — | Not performed for this release |
| 26 | Security review completed | Partially | [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) | Hariprasad | Pradeep | Review performed; one finding documented and deferred to a hardening task |
| 27 | Known limitations documented | Yes | [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) | Hariprasad | Pradeep | Stated openly with planned action for each |
| 28 | No credentials committed to the repository | Yes | — | Hariprasad | Pradeep | Repository scanned; only sample values in example files, flagged for replacement |
| 29 | Repository clean before tagging | Yes | — | Hariprasad | Pradeep | Verified before the release commit |
| 30 | Tag points to the release commit | Yes | [Release](https://github.com/eGov-Global/CMS-MOZAMBIQUE/releases/tag/cms-mozambique-v1.0.0) | Hariprasad | Pradeep | Verified |
| 31 | Release published | Yes | [Release](https://github.com/eGov-Global/CMS-MOZAMBIQUE/releases/tag/cms-mozambique-v1.0.0) | Hariprasad | Pradeep | GitHub release published against the tag |
| 32 | Release documentation merged to the main branch | Partially | [PR #6](https://github.com/eGov-Global/CMS-MOZAMBIQUE/pull/6) | Hariprasad | Pradeep | Awaiting code-owner review on PR 6. The tag carries the release documents but not this checklist, which was added after tagging |
| 33 | Upgrade path from the previous release | Not applicable | [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) | Hariprasad | Pradeep | First Mozambique release; no predecessor |
