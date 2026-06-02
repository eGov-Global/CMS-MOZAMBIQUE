# CMS Mozambique

Flutter WebView wrapper for the DIGIT employee portal at
`http://digit.mctd.gov.mz/digit-ui/employee/user/login`.

## What it does
- Shows a splash screen with the app logo and name.
- Loads the configured URL inside a native WebView (Android & iOS).
- Handles WebView back-navigation, pull-to-refresh, and offline state.

## Configuration

Everything user-facing is driven from
[assets/config/app_config.json](assets/config/app_config.json):

```json
{
  "appName": "CMS Mozambique",
  "url": "http://digit.mctd.gov.mz/digit-ui/employee/user/login",
  "logoAsset": "assets/icons/app_icon.png",
  "primaryColorHex": "#0B4F6C",
  "allowMixedContent": true,
  "javascriptEnabled": true,
  "showAppBar": false,
  "pullToRefresh": true
}
```

| Key | Purpose |
|---|---|
| `appName` | Title used in splash screen and `MaterialApp` |
| `url` | The page the WebView opens on launch |
| `logoAsset` | Asset path of the logo shown on the splash |
| `primaryColorHex` | Theme seed color (e.g. `#0B4F6C`) |
| `allowMixedContent` | Allow `http` resources inside the page |
| `javascriptEnabled` | Toggle JS in the WebView |
| `showAppBar` | Show an app bar with refresh button |
| `pullToRefresh` | Enable pull-to-refresh gesture |

### Change the launcher icon / app display name

1. Replace [assets/icons/app_icon.png](assets/icons/app_icon.png) with a square PNG (>= 1024x1024).
2. Run `flutter pub run flutter_launcher_icons` to regenerate Android/iOS/web icons.
3. Update `android:label` in [android/app/src/main/AndroidManifest.xml](android/app/src/main/AndroidManifest.xml) and `CFBundleDisplayName` in [ios/Runner/Info.plist](ios/Runner/Info.plist) if you change the visible app name.

## Run

```bash
flutter pub get
flutter run                 # connected device or emulator
flutter build apk           # Android release APK
flutter build appbundle     # Android app bundle (Play Store)
flutter build ios           # iOS (requires macOS + Xcode)
```

## Notes
- Android cleartext traffic is enabled (`android:usesCleartextTraffic="true"`) because the target URL uses `http://`. Remove this once the backend serves HTTPS.
- iOS App Transport Security has a specific exception for `digit.mctd.gov.mz` in [ios/Runner/Info.plist](ios/Runner/Info.plist).
- Source layout:
  - [lib/main.dart](lib/main.dart) - entry point, loads config, splash, WebView
  - [lib/src/app_config.dart](lib/src/app_config.dart) - config loader
  - [lib/src/splash_screen.dart](lib/src/splash_screen.dart) - splash UI
  - [lib/src/web_view_screen.dart](lib/src/web_view_screen.dart) - WebView + offline/back/refresh handling
