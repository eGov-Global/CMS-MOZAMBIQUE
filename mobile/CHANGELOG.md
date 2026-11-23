# Changelog — CMS Mozambique mobile app

## [Unreleased]

- Test server switch for Google Play review: ten quick taps on a login page's
  logo, then a confirmation, open the UAT login page, where a test number and
  fixed code work. An amber banner marks every UAT page and leads back; every
  launch starts on production. Its dialogs and banner follow the phone's
  language: Portuguese, or English otherwise. On by default; it can be turned
  off and on remotely with the MDMS record `MobileApp.Settings` /
  `TEST_SERVER_SWITCH` on the test server (`tools/test_server_switch.py`),
  read only after the ten taps. New config keys `testUrl` / `testCitizenUrl` /
  `testTenantId`.

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
