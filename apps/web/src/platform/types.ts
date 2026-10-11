/**
 * What the app needs from the host platform. One implementation each for the
 * browser/PWA, the Electron desktop shell and the Capacitor mobile shell.
 */
import type { Device } from '@neo/protocol';
import type { NeoClient } from '@neo/client';

export type PlatformKind = 'browser' | 'electron' | 'capacitor';

/**
 * How reminders reach the user when NEO isn't in front:
 * - push: Web Push via the service worker (browser/PWA)
 * - os: the desktop app's main process shows OS notifications
 * - local: on-device scheduled notifications (mobile)
 * - none: not available here
 */
export type NotificationChannel = 'push' | 'os' | 'local' | 'none';

export interface NotificationStatus {
  channel: NotificationChannel;
  permission: 'granted' | 'denied' | 'prompt' | 'unsupported';
  /** Reminders will reach this device. */
  enabled: boolean;
  /** Why it is unavailable, e.g. 'insecure-context', 'no-vapid', 'ios-install'. */
  reason?: string;
}

export type ReminderAction = 'snooze' | 'done';

export interface PlatformContext {
  /** Navigate to an in-app link (`neo://…` or a hash route). */
  openLink(url: string): void;
  /** A `neo://pair` link arrived (deep link or QR scan). */
  onPairLink(url: string): void;
  /** A notification action button was pressed. */
  onReminderAction(reminderId: string, action: ReminderAction): void;
  /** The app came back to the foreground (refresh state). */
  onResume(): void;
}

export interface PlatformBridge {
  readonly kind: PlatformKind;
  /** Device platform for pairing (`POST /devices`). */
  readonly devicePlatform: Device['platform'];
  /** Suggested device name ("iPhone", "Mac"). */
  deviceName(): string;
  /** Open a web/mail/tel link outside the app. */
  openExternal(url: string): void;
  notificationStatus(client: NeoClient): Promise<NotificationStatus>;
  enableNotifications(client: NeoClient): Promise<NotificationStatus>;
  disableNotifications(client: NeoClient): Promise<NotificationStatus>;
  /** Re-plan on-device reminder notifications (mobile); no-op elsewhere. */
  syncReminders(client: NeoClient): Promise<void>;
  /** Hook up deep links, notification taps, resume. Returns a cleanup function. */
  init(ctx: PlatformContext): () => void;
  /** Tell background parts of the app (service worker) the UI language. */
  setLocale(locale: string): void;
}
