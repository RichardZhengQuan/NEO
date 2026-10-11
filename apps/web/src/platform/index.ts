/**
 * Platform detection. `@capacitor/core` is safe to import on the web (it
 * installs a web shim), so detection is synchronous; the native plugins
 * themselves are imported lazily by the Capacitor bridge.
 */
import { Capacitor } from '@capacitor/core';
import type { NeoDesktopBridge } from '../connection.js';
import { browserBridge } from './browser.js';
import { createCapacitorBridge } from './capacitor.js';
import { createElectronBridge } from './electron.js';
import type { PlatformBridge, PlatformKind } from './types.js';

export type { NotificationChannel, NotificationStatus, PlatformBridge, PlatformContext, PlatformKind, ReminderAction } from './types.js';
export { registerServiceWorker, urlBase64ToUint8Array, pushUnsupportedReason } from './browser.js';
export { MAX_LOCAL_NOTIFICATIONS, notificationIdFor, planReminderNotifications, staleNotificationIds } from './local-notifications.js';

export interface PlatformEnvironment {
  desktop: NeoDesktopBridge | null | undefined;
  /** Capacitor.isNativePlatform() */
  native: boolean;
  /** Capacitor.getPlatform(): 'ios' | 'android' | 'web' */
  nativePlatform: string;
}

/** Pure detection (unit-tested): desktop bridge wins, then a native Capacitor shell, else browser. */
export function detectPlatform(env: PlatformEnvironment): PlatformKind {
  if (env.desktop && typeof env.desktop.getConfig === 'function') return 'electron';
  if (env.native && (env.nativePlatform === 'ios' || env.nativePlatform === 'android')) return 'capacitor';
  return 'browser';
}

export function currentEnvironment(): PlatformEnvironment {
  let native = false;
  let nativePlatform = 'web';
  try {
    native = Capacitor.isNativePlatform();
    nativePlatform = Capacitor.getPlatform();
  } catch {
    // Not running under Capacitor.
  }
  return { desktop: typeof window !== 'undefined' ? window.neoDesktop : undefined, native, nativePlatform };
}

let instance: PlatformBridge | null = null;

export function createPlatform(env: PlatformEnvironment): PlatformBridge {
  switch (detectPlatform(env)) {
    case 'electron':
      return createElectronBridge(env.desktop!);
    case 'capacitor':
      return createCapacitorBridge(env.nativePlatform === 'android' ? 'android' : 'ios');
    default:
      return browserBridge;
  }
}

/** The bridge for the running host (created once). */
export function getPlatform(): PlatformBridge {
  instance ??= createPlatform(currentEnvironment());
  return instance;
}
