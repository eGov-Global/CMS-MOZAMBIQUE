# Fala Cidadão — mobile app

Flutter WebView wrapper for the Fala Cidadão citizen + employee portal at
`https://falacidadao.gov.mz/digit-ui/`.

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
| `primaryColorHex` | Theme seed color — the site's dark green `#204F37` |
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
| `config/environments/prod.json` | `https://falacidadao.gov.mz` (byte-identical to the bundled default) |
| `config/environments/uat.json` | `https://uat.falacidadao.gov.mz` |

The release workflow's `environment` input copies the chosen file over
`assets/config/app_config.json` before building — no Dart changes needed. For a
local non-prod build do the same copy by hand.

### HTTPS only

Both environments are HTTPS with `allowMixedContent: false`; cleartext traffic
is off on Android (no `usesCleartextTraffic`) and iOS has no App Transport
Security exception. The servers must send the **full certificate chain**
(site certificate + Thawte TLS RSA CA G1 intermediate): Android's WebView does
not fetch missing intermediates, so a leaf-only chain shows the error screen
instead of the site. Check with
`openssl s_client -connect falacidadao.gov.mz:443 -servername falacidadao.gov.mz`
— it must end with `Verify return code: 0`.

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
`FalaCidadao-v<versionName>-b<versionCode>[-<abi>]-release.apk`.

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
| `KEYSTORE_BASE64` | `base64 -w0 falacidadao-upload.jks` |
| `KEYSTORE_PASSWORD` | Store password |
| `KEY_PASSWORD` | Key password |
| `KEY_ALIAS` | `falacidadao` |
| `PLAY_SERVICE_ACCOUNT_JSON` | *(optional)* Play service-account key, enables the upload step |

Create the upload key once, on a trusted machine, and keep the file and both
passwords in the team's password manager:

```bash
keytool -genkeypair -v -keystore falacidadao-upload.jks -alias falacidadao \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Fala Cidadao, O=Inspeccao-Geral do Estado, C=MZ"
```

With Play App Signing (the default for new apps) this is only the *upload*
key: if it is lost, the account owner can ask Google to register a new one.

Without them the build falls back to **debug signing** (see
`build.gradle.kts`) — fine for CI smoke tests, not installable over a
release-signed build and not accepted by Google Play. Never commit `*.jks`,
`*.keystore` or `key.properties`; they are gitignored. **Back up the keystore
separately** — losing it means never being able to update the same Play
listing.

## Google Play release

Package `mz.gov.falacidadao` (permanent once the first build is uploaded),
Play listing "Fala Cidadão".

1. **First upload by hand.** Google's API only accepts uploads for an app that
   already has one. Run **Actions → "Mobile Build APK/AAB"** (environment
   `prod`, track `none`), download the `.aab` from the run's artifacts, and in
   Play Console create a release on **Test and release → Internal testing**
   with it. Add the testers' emails there.
2. **Service account (once).** In Google Cloud, create a service account with
   the *Google Play Android Developer API* enabled and download a JSON key. In
   Play Console, **Users and permissions → Invite new users** with the service
   account's email, permission *Release to testing tracks* for this app (add
   *Release to production* to use the production track). Store the JSON as the
   `PLAY_SERVICE_ACCOUNT_JSON` secret in the `production` environment.
3. **Every later release.** Bump the version, then tag `app-vX.Y.Z` (uploads to
   internal testing) or run the workflow with track `internal` or
   `production`. Production uploads are created as a **draft**: open Play
   Console, check the release and press *Send for review*.

The build number is the workflow run number, so every upload has a higher
`versionCode` than the last. The store texts and graphics for the listing are
in [store/](store/).

## Source layout

- [lib/main.dart](lib/main.dart) — entry point, splash + WebView bootstrap
- [lib/src/app_config.dart](lib/src/app_config.dart) — config loader
- [lib/src/splash_screen.dart](lib/src/splash_screen.dart) — splash UI + version footer
- [lib/src/web_view_screen.dart](lib/src/web_view_screen.dart) — WebView, error / offline / pull-to-refresh handling
