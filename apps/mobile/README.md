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
`apps/mobile/` (they are gitignored in most projects; commit them if you want
CI to build the native side).

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

## Connecting to a self-hosted NEO server

When the app launches for the first time it shows the **Connect** screen.  Enter
your server URL and owner token, or scan the **pairing QR code** from
**Settings → Devices** in any connected NEO client.

The pairing link looks like:

```
https://neo.example.com/pair?token=<device-token>
```

The app saves the server URL and token in the device keychain / encrypted
storage so you only need to pair once.

### Development / LAN server

If your NEO server is running on the same local network without TLS, you need
to allow cleartext HTTP:

#### Android — `network_security_config.xml`

Capacitor injects a default config that allows localhost.  For LAN servers, add
a `res/xml/network_security_config.xml` to your Android project:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <!-- Allow cleartext for local network servers during development -->
  <domain-config cleartextTrafficPermitted="true">
    <!-- Replace with your server's IP or hostname -->
    <domain includeSubdomains="false">192.168.1.100</domain>
  </domain-config>
</network-security-config>
```

Then reference it in `AndroidManifest.xml`:

```xml
<application
  android:networkSecurityConfig="@xml/network_security_config"
  ...>
```

#### iOS — App Transport Security (ATS)

iOS requires HTTPS by default.  For local development, you can add an ATS
exception in `ios/App/App/Info.plist`:

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key>
  <true/>
  <!-- Only add NSAllowsArbitraryLoads if you really need it (not recommended) -->
</dict>
```

For production, always serve NEO behind a valid TLS certificate (see
`docs/DEPLOYMENT.md` for the Caddy reverse-proxy example).

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
