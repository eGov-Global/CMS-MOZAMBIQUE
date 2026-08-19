# CMS Mozambique v1.0.0 — Release Notes

**Product:** DIGIT Complaint Management System — Mozambique
**Release:** `cms-mozambique-v1.0.0` · **Released:** 17 August 2026
**Built on:** DIGIT CCRS `release-v2.12-moz`

This release formally freezes the Mozambique complaint management system that has been deployed for UAT validation. It packages and documents the solution built for the Inspecção Geral do Estado (IGE); it does not change how the application behaves.

---

## Release Summary

- Citizen complaint filing in Portuguese, with guided 3-step form and map-based location
- Oversight authority routing — complaints reach the right institution automatically
- Multi-tier CMS complaint workflow: reception → screening → supervision → case management
- Confidential complaints with restricted visibility of complainant details
- Department-based access control so staff see only their own department's complaints
- Cross-department search for administrators
- Notifications to citizens and officers at every stage of the complaint journey
- Supervisor dashboard with live complaint indicators, charts and maps
- Configurator screens for departments, complaint categories, notifications and the public landing page
- Public landing page and privacy notice, configurable without a code change
- One-command environment setup through the unified migration runner

---

## New Feature Additions

| Feature | Description |
|---|---|
| **Oversight authority routing** | A complaint is automatically directed to the correct oversight institution. Where a single authority is configured, the citizen is not asked to choose — the system routes it silently. |
| **Multi-tier complaint workflow** | Complaints move through Reception, Screening, Supervision and Case Management, with assignment, escalation, send-back, resolution, reopening and rating. Officers only see the actions their role permits. |
| **Confidential complaints** | A complaint can be marked confidential. Complainant details are then masked and visible only to officers holding the confidential-viewer role. |
| **Category-specific questions** | Each complaint category can ask its own additional questions, configured as master data rather than built into the form. |
| **Department-scoped access** | Officers see only complaints belonging to their own department. Optional and switched off until a deployment turns it on. |
| **Cross-department administrator search** | Administrators can search complaints across all departments, with filters for department, date range and complaint number. |
| **Journey notifications** | Citizens and officers are notified by email at each stage — assignment, send-back, reopening and rating. Recipients, channels and message templates are configured, not coded. |
| **Supervisor dashboard** | Live counts, resolution times, charts, complaint maps and CSV export, scoped to the viewer's jurisdiction. |
| **Public landing page** | A configurable public page and privacy notice, editable from the Configurator without a release. |
| **Portuguese language** | Full Portuguese (pt_PT) interface for citizens and officers, with English available. |

---

## Enhancements

| Updated Feature | Description | Category | Reference |
|---|---|---|---|
| Complaint categories | Categories are no longer limited to two levels. A county can structure them to any depth to match its service catalogue. | Master data | [Configuration](CONFIGURATION.md) |
| Complaint filing | The citizen form was reorganised into three clear steps with map-based location capture and Portuguese validation messages. | Frontend | [Matrix — Frontend](MOZAMBIQUE-CUSTOMIZATION-MATRIX.md) |
| Officer inbox | Reception officers can see the complaints they filed on a citizen's behalf; sorting, filtering and pagination were corrected. | Frontend | [Matrix — Frontend](MOZAMBIQUE-CUSTOMIZATION-MATRIX.md) |
| Complaint assignment | Reopening and rating a complaint now route back to the officer who handled it, instead of returning to the general queue. | Workflow | [Matrix — Workflow](MOZAMBIQUE-CUSTOMIZATION-MATRIX.md) |
| Notifications | Messages now name the correct officer and department, and no longer fail when a category has no department mapping. | Backend | [Matrix — Backend](MOZAMBIQUE-CUSTOMIZATION-MATRIX.md) |
| Attachments | Documents, images and video can be attached at every workflow step; accepted formats are stated on screen. | Frontend | [Matrix — Frontend](MOZAMBIQUE-CUSTOMIZATION-MATRIX.md) |
| Configurator | Departments, complaint categories, roles, notification rules and landing content are editable from the UI; edits appear immediately. | Configurator | [Matrix — Configurator](MOZAMBIQUE-CUSTOMIZATION-MATRIX.md) |
| Environment setup | A single command seeds master data, roles, workflow and content for a new environment, and can be re-run safely. | Deployment | [Deployment](DEPLOYMENT.md) |
| Page loading speed | Compression and caching were enabled for the citizen and officer applications. | Infrastructure | [Deployment](DEPLOYMENT.md) |

---

## UAT Status

| Item | Status |
|---|---|
| Environment | cms-pilot.digit.org |
| Application code in this release | Unchanged — this release adds documentation only |
| Complaint filing, assignment, resolution, reopening, rating | Exercised on the environment |
| Notifications for assignment, send-back, reopening, rating | Exercised — delivery confirmed in the notification log |
| Document upload and retrieval | Exercised across all advertised formats |
| Supervisor dashboard | Exercised with seeded indicators |
| Formal UAT sign-off record | Not available in the repository |
| Automated regression tests | Not available — validation is manual |

Full evidence: [UAT and verification detail](MOZAMBIQUE-CUSTOMIZATION-MATRIX.md).

---

## Database Changes

**None.** This release introduces no database changes of its own. All database structures come from the upstream DIGIT CCRS product and are unchanged, so no migration step is required for either a new installation or an upgrade.

---

## Deployment

A new environment is set up with the standard DIGIT single-server installation, followed by one command that seeds Mozambique master data, roles, workflow and content.

One step is manual in this release: the CMS roles and workflow seeding command must be run after deployment, and the workflow service restarted once. Both are covered step by step in the [Deployment guide](DEPLOYMENT.md).

---

## Known Limitations

| Item | Impact | Planned action |
|---|---|---|
| The administrator complaint search does not verify the user's role on the server | An officer could reach cross-department results by calling the service directly | Security hardening task in a following release |
| Three privileged roles are not created automatically | An administrator must add them once, per environment | Documented in [Configuration](CONFIGURATION.md); automated upstream, adopted in a following release |
| CMS roles and workflow seeding is a manual step | One command after deployment | Automated upstream, adopted in a following release |
| No automated regression tests | Changes are validated manually | Test suite planned as separate work |
| Sample environment settings file is development-shaped | Must be corrected before a production deployment | Corrections listed in [Deployment](DEPLOYMENT.md) |

The complete list, including items intentionally deferred, is in [Future Work](MOZAMBIQUE-CUSTOMIZATION-MATRIX.md).

---

## Upgrade Notes

There is no earlier Mozambique release, so this is a baseline. An existing environment moves to this release by deploying the tagged version; no data migration is required.

Nine improvements made in the upstream product after this release was frozen are deliberately not included, so that what is released is exactly what was validated. They will be picked up in a following release after regression testing.

---

## Document Resources & Links

| Business & release documents | Technical reference documents |
|---|---|
| [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) (this page) | [Mozambique Customization Matrix](MOZAMBIQUE-CUSTOMIZATION-MATRIX.md) |
| [Gate 2 Release Checklist](GATE-2-RELEASE-CHECKLIST.md) | [Upstream Baseline](UPSTREAM-BASELINE.md) |
| [Changelog](CHANGELOG.md) | [Configuration & Master Data](CONFIGURATION.md) |
| [Documentation index](README.md) | [Deployment Guide](DEPLOYMENT.md) |
| | [Release Manifest](release-manifest.yml) |
