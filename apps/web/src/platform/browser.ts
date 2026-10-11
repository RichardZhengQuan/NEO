/**
 * Browser / PWA bridge: Web Push through the service worker (works with the
 * tab closed), the Notification permission, and service-worker messages for
 * notification clicks and action buttons.
 */
import type { PushSubscriptionJSON } from '@neo/protocol';
import type { NeoClient } from '@neo/client';
import type { NotificationStatus, PlatformBridge, PlatformContext, ReminderAction } from './types.js';

/** VAPID public keys are url-safe base64. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/** Why push can't work here, or null when it can. */
export function pushUnsupportedReason(): string | null {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure-context';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIos() && !isStandalone() ? 'ios-install' : 'unsupported';
  return null;
}

/** Register the app's service worker relative to the app base (works under sub-paths). */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const url = new URL('sw.js', document.baseURI);
    const scope = new URL('./', document.baseURI);
    return await navigator.serviceWorker.register(url.href, { scope: scope.pathname });
  } catch {
    return null;
  }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  try {
    const reg = await navigator.serviceWorker.getRegistration(new URL('./', document.baseURI).href);
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

function permissionState(): NotificationStatus['permission'] {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission === 'default' ? 'prompt' : Notification.permission;
}

async function status(client: NeoClient): Promise<NotificationStatus> {
  const reason = pushUnsupportedReason();
  if (reason) return { channel: 'push', permission: 'unsupported', enabled: false, reason };
  const permission = permissionState();
  let key: string | null = null;
  try {
    key = await client.push.vapidPublicKey();
  } catch {
    key = null;
  }
  if (!key) return { channel: 'push', permission, enabled: false, reason: 'no-vapid' };
  const sub = await currentSubscription();
  return { channel: 'push', permission, enabled: permission === 'granted' && sub !== null };
}

function toJson(sub: PushSubscription): PushSubscriptionJSON | null {
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return null;
  return { endpoint: json.endpoint, expirationTime: json.expirationTime ?? null, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

let subscriptionRefreshed = false;

export const browserBridge: PlatformBridge = {
  kind: 'browser',
  devicePlatform: 'web',

  deviceName() {
    const ua = navigator.userAgent;
    if (/iphone/i.test(ua)) return 'iPhone';
    if (/ipad/i.test(ua)) return 'iPad';
    if (/android/i.test(ua)) return 'Android';
    if (/mac/i.test(ua)) return 'Mac';
    if (/windows/i.test(ua)) return 'Windows PC';
    if (/linux/i.test(ua)) return 'Linux';
    return 'Browser';
  },

  openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  notificationStatus: status,

  async enableNotifications(client) {
    const reason = pushUnsupportedReason();
    if (reason) return { channel: 'push', permission: 'unsupported', enabled: false, reason };
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return status(client);
    const key = await client.push.vapidPublicKey().catch(() => null);
    if (!key) return { channel: 'push', permission: 'granted', enabled: false, reason: 'no-vapid' };
    const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
    await navigator.serviceWorker.ready;
    const appKey = urlBase64ToUint8Array(key);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options.applicationServerKey, appKey)) {
      // The server's VAPID keys changed: the old subscription can't be used.
      await sub.unsubscribe().catch(() => undefined);
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    const json = toJson(sub);
    if (!json) return { channel: 'push', permission: 'granted', enabled: false, reason: 'unsupported' };
    await client.push.subscribe(json);
    return { channel: 'push', permission: 'granted', enabled: true };
  },

  async disableNotifications(client) {
    const sub = await currentSubscription();
    if (sub) {
      await client.push.unsubscribe(sub.endpoint).catch(() => undefined);
      await sub.unsubscribe().catch(() => undefined);
    }
    return status(client);
  },

  async syncReminders(client) {
    // Reminders are pushed by the server; nothing is scheduled on the device.
    // Once per session, re-register an existing subscription so a server that
    // lost it (restore, new data dir) keeps reaching this browser.
    if (subscriptionRefreshed || pushUnsupportedReason() || Notification.permission !== 'granted') return;
    subscriptionRefreshed = true;
    const sub = await currentSubscription();
    const json = sub ? toJson(sub) : null;
    if (json) await client.push.subscribe(json).catch(() => undefined);
  },

  init(ctx: PlatformContext) {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string; reminderId?: string; action?: string } | null;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'neo:navigate' && typeof data.url === 'string') ctx.openLink(data.url);
      if (data.type === 'neo:reminder-action' && typeof data.reminderId === 'string' && (data.action === 'snooze' || data.action === 'done')) {
        ctx.onReminderAction(data.reminderId, data.action as ReminderAction);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') ctx.onResume();
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisible);
    };
  },

  setLocale(locale) {
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: 'neo:locale', locale });
    } catch {
      // No controller yet; the service worker falls back to English.
    }
  },
};
