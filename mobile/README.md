# CMS Mozambique — mobile app

Flutter WebView wrapper for the DIGIT employee + citizen portal at
`http://digit.mctd.gov.mz/digit-ui/`.

This directory was imported (with history, via `git subtree`) from
[Hari-egov/CMS-App](https://github.com/Hari-egov/CMS-App). **This monorepo is
the canonical source for the mobile app**; do not commit to the old repository.

- **Flutter version (pinned, local = CI):** `3.38.7` — declared in
  [.github/workflows/mobile-ci.yml](../.github/workflows/mobile-ci.yml) and
  [.github/workflows/mobile-build-apk.yml](../.github/workflows/mobile-build-apk.yml).
- **Android application ID:** `mz.gov.falacidadao` — must stay stable;
  it identifies the app in the Google Play Console.
- **iOS bundle:** see [ios/Runner/Info.plist](ios/Runner/Info.plist).

## What it does

- Branded splash screen that stays visible until the WebView finishes loading.
- Loads the configured login URL (citizen by default) inside a native WebView.
- Pull-to-refresh, offline snackbar, page-load error screen, double-back-to-exit.
- External links (`mailto:` / `tel:` / off-host URLs) open in the OS default app.

## Configuration

Everything user-facing is driven from
[assets/config/app_config.json](assets/config/app_config.json):

| Key | Purpose |
|---|---|
| `appName` | Title used in splash screen and `MaterialApp` |
| `url` | Employee login URL |
| `citizenUrl` | Citizen login URL |
| `startWithCitizen` | `true` → open citizen URL on launch; `false` → employee URL |
| `logoAsset` | Asset path of the logo shown on the splash |
| `primaryColorHex` | Theme seed color (e.g. `#0B4F6C`) |
| `allowMixedContent` | Allow `http` resources inside the page |
| `javascriptEnabled` | Toggle JS in the WebView |
| `showAppBar` | Show an app bar with refresh button |
| `pullToRefresh` | Enable pull-to-refresh gesture |

### Environments (DEV / UAT / PROD)

The **bundled** `assets/config/app_config.json` is the production
configuration. Environment variants live in
[config/environments/](config/environments/) — deliberately *outside*
`assets/` so only the selected one ships in a build:

| File | Points at |
|---|---|
| `config/environments/prod.json` | `http://digit.mctd.gov.mz` (byte-identical to the bundled default) |
| `config/environments/uat.json` | `https://cms-pilot.digit.org` (HTTPS, no mixed content) |

The release workflow's `environment` input copies the chosen file over
`assets/config/app_config.json` before building — no Dart changes needed. For a
local non-prod build do the same copy by hand.

### ⚠ HTTP / cleartext — a documented security exception

Production currently uses `http://digit.mctd.gov.mz` with
`allowMixedContent: true` and `android:usesCleartextTraffic="true"`
(plus an iOS ATS exception for `digit.mctd.gov.mz` in `Info.plist`)
**because the MCTD production endpoint's HTTPS is broken**. This is technical
debt, not a preference.

**TODO (tracked debt):** once `https://digit.mctd.gov.mz` works — switch
`url`/`citizenUrl` to `https`, set `allowMixedContent: false`, remove
`usesCleartextTraffic` from
[android/app/src/main/AndroidManifest.xml](android/app/src/main/AndroidManifest.xml),
and drop the ATS exception. Do not add further cleartext endpoints in the
meantime; UAT already uses HTTPS.

## Run locally

Use Flutter `3.38.7` (match CI — [FVM](https://fvm.app) works: `fvm use 3.38.7`).

```bash
flutter pub get
flutter analyze
flutter test
flutter run                                       # debug, connected device
flutter build apk --release --target-platform android-arm64
flutter build appbundle --release                 # Google Play artifact
flutter build ios --release                       # iOS (macOS + Xcode required)
```

Release APKs are renamed via
[android/app/build.gradle.kts](android/app/build.gradle.kts) to
`CMS_Mozambique-v<versionName>-b<versionCode>[-<abi>]-release.apk`.

### Change the launcher icon / app display name

1. Replace [assets/icons/app_icon.png](assets/icons/app_icon.png) with a square PNG (≥ 1024×1024).
2. Run `flutter pub run flutter_launcher_icons` to regenerate Android/iOS/web icons.
3. Update `android:label` in the AndroidManifest and `CFBundleDisplayName` in `Info.plist` if the visible name changes.

## Versioning and tags

Version lives in [pubspec.yaml](pubspec.yaml) as `version: <name>+<code>`:

- **name** (`1.0.0`) → user-facing `versionName` / Play Store version
- **code** (`+1`) → integer `versionCode`, must increase for every Play upload

Mobile releases are tagged **`app-vX.Y.Z`** — never plain `vX.Y.Z`, which
belongs to CMS platform releases in this repository. The two version lines are
independent (platform `v2.12.0` and mobile `app-v1.0.0` can coexist).

To bump: **Actions → "Mobile Bump Version"** → choose patch/minor/major. It
opens a PR against `develop` (it never pushes to `develop` directly). After the
PR merges, tag the merge commit:

```bash
git tag app-v1.0.1 && git push origin app-v1.0.1
```

## CI / CD

Three root-level workflows, all path-filtered to `mobile/**` so the rest of
the monorepo never triggers them:

| Workflow | Trigger | Output |
|---|---|---|
| [mobile-ci.yml](../.github/workflows/mobile-ci.yml) | PR to master/develop, push to develop | analyze + test + **unsigned** arm64 APK artifact (7 days) |
| [mobile-build-apk.yml](../.github/workflows/mobile-build-apk.yml) | `app-v*.*.*` tag, manual dispatch | analyze + test + **signed** APK **and AAB** artifacts (30 days); GitHub Release on tags |
| [mobile-bump-version.yml](../.github/workflows/mobile-bump-version.yml) | manual dispatch | version-bump **PR** against develop |

Every release build is traceable: version, build number (= run number), git
commit SHA, environment and signing state are stamped into the GitHub Release
body, and the version/build number are baked into the APK/AAB via
`--build-name` / `--build-number`.

### Required GitHub Secrets (signed builds)

Repo- or `production`-environment-scoped, under
**Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `KEYSTORE_BASE64` | `base64 -w0 cms_mozambique-release.keystore` |
| `KEYSTORE_PASSWORD` | Store password |
| `KEY_PASSWORD` | Key password |
| `KEY_ALIAS` | `cms_mozambique` |

Without them the build falls back to **debug signing** (see
`build.gradle.kts`) — fine for CI smoke tests, not installable over a
release-signed build and not accepted by Google Play. Never commit `*.jks`,
`*.keystore` or `key.properties`; they are gitignored. **Back up the keystore
separately** — losing it means never being able to update the same Play
listing.

## Google Play readiness

The pipeline already produces the Play artifact (the `.aab`) and the
application ID `mz.gov.falacidadao` is stable. When publishing is
switched on, the intended flow is:

```
build → sign → AAB → GitHub Release → Play Internal Testing → Production
```

Play credentials (service-account JSON) belong in the same `production`
GitHub Environment as the signing secrets, and the upload step slots into
`mobile-build-apk.yml` after "Build AAB". Publishing is deliberately **not**
wired up yet.

## Source layout

- [lib/main.dart](lib/main.dart) — entry point, splash + WebView bootstrap
- [lib/src/app_config.dart](lib/src/app_config.dart) — config loader
- [lib/src/splash_screen.dart](lib/src/splash_screen.dart) — splash UI + version footer
- [lib/src/web_view_screen.dart](lib/src/web_view_screen.dart) — WebView, error / offline / pull-to-refresh handling
