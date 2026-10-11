/**
 * Capacitor configuration for NEO mobile (iOS & Android).
 *
 * The app wraps the same web build used by the desktop and PWA, connecting to
 * a NEO server over HTTPS or an encrypted LAN tunnel after scanning a pairing code.
 * Native URL-scheme and camera permissions are documented in README.md.
 * Reminders are scheduled as on-device local
 * notifications so they fire even when the server is unreachable.
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.neo.app',
  appName: 'NEO',

  /**
   * Path to the built web application (relative to this file's directory).
   * Run `pnpm --filter @neo/web build` before syncing.
   */
  webDir: '../web/dist',

  server: {
    /**
     * Use https:// as the scheme for Android WebView so cookies and service
     * workers behave like a real origin.  On iOS WKWebView the origin is
     * capacitor://localhost by default; ATS notes apply (see README.md).
     */
    androidScheme: 'https',

    /**
     * In development you can point the app at a local server so hot-reload
     * works inside the native shell.  Comment this out for production builds.
     *
     * url: 'http://192.168.1.100:7777',
     * cleartext: true,
     */
  },

  android: {
    // The WebView origin is https://localhost; LAN uses ws:// to a private
    // address. Its payload is end-to-end encrypted and the server key is pinned.
    allowMixedContent: true,
  },

  plugins: {
    /**
     * Local notifications — the web app's Capacitor bridge schedules up to 64
     * upcoming reminders via @capacitor/local-notifications so they fire even
     * when the device is offline or the NEO server is unreachable.
     *
     * Both platforms require the user to grant notification permission; the web
     * app requests it during onboarding.
     */
    LocalNotifications: {
      smallIcon: 'ic_stat_neo',
      iconColor: '#0A84FF',
      sound: 'beep.wav',
    },

    /**
     * SplashScreen is not bundled here; remove this block if you add the plugin.
     * The web app handles its own loading state.
     */
  },
};

export default config;
