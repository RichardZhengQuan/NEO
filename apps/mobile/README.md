# NEO Mobile

iOS and Android apps for NEO, built with [Capacitor](https://capacitorjs.com/).
The mobile app is a thin native shell around the same web build used by the
desktop app and PWA — no separate React code to maintain.

## Prerequisites

- **Node.js ≥ 22.13** and **pnpm ≥ 11** (same as the rest of the monorepo)
- **iOS**: macOS with Xcode ≥ 16, Xcode Command Line Tools, CocoaPods
- **Android**: Android Studio ≥ Hedgehog, JDK 17

---

## Build steps

### 1. Build the web app

```bash
# From the repository root:
pnpm --filter @neo/web build
```

This produces `apps/web/dist/`, which `capacitor.config.ts` points at as `webDir`.

### 2. Add a platform (first time only)

```bash
# iOS
cd apps/mobile
npx cap add ios

# Android
npx cap add android
```

This creates the `ios/` and `android/` native project directories inside
`apps/mobile/`. They are not committed here; configure them as described below
before running on a phone.

### 3. Sync web assets and plugins

```bash
npx cap sync
```

Run this every time you rebuild the web app or install a new Capacitor plugin.
It copies `apps/web/dist/` into the native projects and updates the plugin
registrations.

### 4. Open in the native IDE

```bash
# Xcode
npx cap open ios

# Android Studio
npx cap open android
```

Then build and run from the IDE as usual.  You can also use
`npx cap run ios --livereload` (requires the dev server to be reachable from
the device) during development.

---

## Connecting

1. On your computer, open NEO → **Settings → Devices → Pair a phone**.
2. Open NEO on your phone and tap **Scan**. Point the camera at the code on
   your computer.
3. Your phone connects and remembers the connection. Your computer must stay
   on with NEO running.

If you cannot scan, expand **Can't scan? Copy the link** on the computer, then
use **Paste a pairing link instead** on the phone. You can also tap a
`neo://pair` link to open NEO. Each code works once and expires after five
minutes; use **Show a new code** if it expires.

On the same network, phones use the encrypted LAN tunnel for an on-device
computer. Self-hosted servers with a public HTTPS address use that address.
Native network permissions are described in **Reaching your computer** below.

### Native pairing and camera configuration

The native projects created by `npx cap add` need the `neo://` URL scheme and
camera access for `@capacitor/barcode-scanner`.

In `ios/App/App/Info.plist`, add the URL scheme and camera usage description:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>neo</string></array>
  </dict>
</array>
<key>NSCameraUsageDescription</key>
<string>Scan the pairing code on your computer to connect NEO.</string>
```

In `android/app/src/main/AndroidManifest.xml`, add the camera permission under
`<manifest>`:

```xml
<uses-permission android:name="android.permission.CAMERA" />
```

Add this intent filter inside the main activity (which must have
`android:exported="true"`):

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="neo" android:host="pair" />
</intent-filter>
```

Run `npx cap sync` after installing plugins and after rebuilding the web app
so the native projects receive the scanner and deep-link plugin registrations.

The server must allow the native WebView origin in `server.corsOrigins`:
`https://localhost` for the configured Android scheme, and
`capacitor://localhost` for iOS. Local mode already allows the iOS origin, but
its existing localhost allowance covers HTTP rather than Android's HTTPS
origin. These origins identify the app shell for direct HTTP connections. The LAN
tunnel dispatches requests within the encrypted channel without browser CORS
preflights.

### Reaching your computer

Turn on **Settings → Devices → Phone access** on the computer, then pair your
phone while both devices are on the same network. Pairing also turns phone
access on for an on-device server. The computer must stay on with NEO running.
The LAN listener uses `ws://` on port 7778 by default, but carries only Noise
ciphertext: the phone pins the server key from the pairing code. It never
serves a plaintext API. A relay in the next phase will use `wss://`.

The generated native projects need the following network permissions. These
settings and the LAN tunnel have **not yet been verified on physical devices**.

#### iOS — local network permission and App Transport Security

Add these entries to `ios/App/App/Info.plist`:

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>NEO connects securely to your computer on your local network.</string>
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key>
  <true/>
</dict>
```

The local-network permission allows discovery and connection to the computer;
`NSAllowsLocalNetworking` permits the local `ws://` transport. Noise encryption
and the pinned server key protect everything inside it.

#### Android — network security configuration

Add `android/app/src/main/res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <!-- Cleartext WebSocket transport carries only encrypted tunnel frames. -->
  <base-config cleartextTrafficPermitted="true" />
</network-security-config>
```

Reference it from `AndroidManifest.xml`:

```xml
<application
  android:networkSecurityConfig="@xml/network_security_config"
  ...>
```

The Capacitor config enables `android.allowMixedContent` because its WebView
origin is `https://localhost` while the private LAN address uses `ws://`.
Cleartext permission applies to the transport; phone requests, tokens and
responses inside the tunnel remain end-to-end encrypted. Direct public server
connections should still use HTTPS.

---

## Local notifications (reminders)

The web app's Capacitor bridge (`src/platform/capacitor.ts` in `apps/web`)
schedules upcoming reminders as on-device local notifications via
`@capacitor/local-notifications`.  Up to 64 reminders are scheduled at a time;
the list is refreshed whenever the server sends a `reminder.updated`,
`reminder.created` or `reminder.deleted` WebSocket event.

This ensures reminders fire **even when the device is offline** or the NEO
server is temporarily unreachable.

### Permission

`@capacitor/local-notifications` requests the `POST_NOTIFICATIONS` permission
(Android 13+) and the iOS notification permission automatically when
`requestPermissions()` is called.  The web app requests this during the
onboarding wizard.

### Deep links

Tapping a reminder notification opens the app and navigates to
`#/reminders/<id>`.  `@capacitor/app` handles the URL open event and passes it
to the web app's hash router.

---

## Typecheck

```bash
# From apps/mobile
npx tsc -p tsconfig.json --noEmit
```

---

## Notes

- `src/index.ts` is intentionally minimal; all app logic lives in `apps/web`.
- Native icons and splash screens are managed inside the native IDE projects
  (`ios/App/App/Assets.xcassets`, `android/app/src/main/res/`).
- To update Capacitor plugins, bump their versions in `package.json` and
  re-run `npx cap sync`.
