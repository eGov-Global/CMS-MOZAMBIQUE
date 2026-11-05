# Changelog — CMS Mozambique mobile app

## [Unreleased]

- Downloads started inside the page (the complaint receipt PDF) now reach the
  citizen: the app catches them and opens the system share sheet to save or
  view the file (#173). Adds `path_provider` and `share_plus`.

## [1.0.0] - 2026-08-24

- Initial import into the CMS-MOZAMBIQUE monorepo from
  [Hari-egov/CMS-App](https://github.com/Hari-egov/CMS-App) (history preserved
  via `git subtree`).
- Flutter WebView shell around the DIGIT citizen/employee portal, runtime
  configuration in `assets/config/app_config.json`.
- CI/CD moved to repository-root workflows: `mobile-ci.yml`,
  `mobile-build-apk.yml` (APK + AAB, `app-vX.Y.Z` release tags),
  `mobile-bump-version.yml` (PR-based version bumps).
