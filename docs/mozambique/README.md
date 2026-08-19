# CMS Mozambique — Release Documentation

Documentation for the DIGIT Complaint Management System as implemented for Mozambique (Inspecção Geral do Estado).

This repository holds the Mozambique implementation of the DIGIT CCRS product. It mirrors the Mozambique development line maintained in the upstream product repository, plus deployment settings specific to this installation.

---

## Start here

| If you want to… | Read |
|---|---|
| Understand what this release contains | [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md) |
| Check release readiness and sign-off | [Gate 2 Release Checklist](GATE-2-RELEASE-CHECKLIST.md) |
| See what changed compared to the DIGIT product | [Customization Matrix](MOZAMBIQUE-CUSTOMIZATION-MATRIX.md) |
| See the change history | [Changelog](CHANGELOG.md) |

## Technical reference

| Document | Purpose |
|---|---|
| [Upstream Baseline](UPSTREAM-BASELINE.md) | Exactly which version of the DIGIT product this release is built on, and how to verify it |
| [Configuration & Master Data](CONFIGURATION.md) | Every setting a new environment needs, separating product configuration from environment-specific values |
| [Deployment Guide](DEPLOYMENT.md) | Installation sequence, manual steps, health checks and rollback |
| [Release Manifest](release-manifest.yml) | Machine-readable summary of the release |

---

## What was customized for Mozambique?

The short answer is in the [Release Notes](RELEASE-NOTES-cms-mozambique-v1.0.0.md). The complete answer — every change, what the product did before, what it does for Mozambique, and the impact on data, configuration and deployment — is in the [Customization Matrix](MOZAMBIQUE-CUSTOMIZATION-MATRIX.md), organised by product area: backend, frontend, dashboard, configurator, master data, localization, workflow, roles, deployment, infrastructure and documentation.

## Release identity

| | |
|---|---|
| Release | `cms-mozambique-v1.0.0` |
| Released | 17 August 2026 |
| Built on | DIGIT CCRS `release-v2.12-moz` |
| Database changes | None |
