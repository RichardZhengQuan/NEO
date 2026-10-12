/**
 * Mobile (Capacitor) bridge.
 *
 * Reminders are also scheduled as on-device local notifications so they fire
 * even when the phone can't reach the server. We keep the next 64 upcoming
 * reminders scheduled and re-plan on reminder events, reconnects and resume.
 * Notification taps open the source message or reminder; "Snooze 10 min" / "Done"
 * buttons call the API. `neo://` deep links (pairing, routes) come through
 * @capacitor/app. Plugins are imported lazily so web bundles stay lean.
 */
import type { NeoClient } from '@neo/client';
import { STORAGE_KEYS, readJson, readString, writeJson, writeString } from '../lib/storage.js';
import { planReminderNotifications, staleNotificationIds } from './local-notifications.js';
import type { NotificationStatus, PlatformBridge, PlatformContext } from './types.js';

const ACTION_TYPE = 'neo-reminder';

const STRINGS: Record<'en' | 'zh', { snooze: string; done: string; body: string; scanInstructions: string }> = {
  en: { snooze: 'Snooze 10 min', done: 'Done', body: "It's time", scanInstructions: 'Point the camera at the code on your computer' },
  zh: { snooze: '10 分钟后提醒', done: '完成', body: '时间到了', scanInstructions: '将相机对准电脑上的二维码' },
};

type Os = 'ios' | 'android' | 'web';

const isPairLink = (url: string) => /^neo:\/\/pair(?:[/?#]|$)/i.test(url);
const handledLaunchLinks = new Set<string>();

export function createCapacitorBridge(os: Os): PlatformBridge {
  let strings = STRINGS.en;
  let syncing: Promise<void> | null = null;
  let again = false;

  const disabledByUser = () => readString(STORAGE_KEYS.localNotifications) === 'off';

  async function permission(): Promise<NotificationStatus['permission']> {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const p = await LocalNotifications.checkPermissions();
      return p.display === 'granted' ? 'granted' : p.display === 'denied' ? 'denied' : 'prompt';
    } catch {
      return 'unsupported';
    }
  }

  async function status(): Promise<NotificationStatus> {
    const p = await permission();
    return { channel: 'local', permission: p, enabled: p === 'granted' && !disabledByUser() };
  }

  async function syncOnce(client: NeoClient): Promise<void> {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const perm = await LocalNotifications.checkPermissions();
    const pending = (await LocalNotifications.getPending()).notifications;
    if (perm.display !== 'granted' || disabledByUser()) {
      if (pending.length) await LocalNotifications.cancel({ notifications: pending.map((n) => ({ id: n.id })) });
      return;
    }
    const { items } = await client.reminders.list({ status: ['scheduled'], limit: 500 });
    const plan = planReminderNotifications(items, Date.now(), { defaultBody: strings.body });
    const stale = staleNotificationIds(pending, plan);
    if (stale.length) await LocalNotifications.cancel({ notifications: stale.map((id) => ({ id })) });
    if (plan.length) {
      await LocalNotifications.schedule({
        notifications: plan.map((p) => ({
          id: p.id,
          title: p.title,
          body: p.body,
          schedule: { at: new Date(p.at), allowWhileIdle: true },
          actionTypeId: ACTION_TYPE,
          extra: { reminderId: p.reminderId, url: p.url },
        })),
      });
    }
  }

  /** Coalesces bursts of reminder events into sequential syncs. */
  async function sync(client: NeoClient): Promise<void> {
    if (syncing) {
      again = true;
      return syncing;
    }
    syncing = (async () => {
      do {
        again = false;
        try {
          await syncOnce(client);
        } catch {
          // Offline or plugin unavailable: the next event/resume retries.
        }
      } while (again);
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  async function registerActions(): Promise<void> {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.registerActionTypes({
      types: [
        {
          id: ACTION_TYPE,
          actions: [
            { id: 'snooze', title: strings.snooze },
            { id: 'done', title: strings.done },
          ],
        },
      ],
    });
  }

  return {
    kind: 'capacitor',
    devicePlatform: os === 'android' ? 'android' : 'ios',

    deviceName() {
      return os === 'android' ? 'Android phone' : 'iPhone';
    },

    async scanQrCode() {
      try {
        const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } = await import('@capacitor/barcode-scanner');
        const result = await CapacitorBarcodeScanner.scanBarcode({
          hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
          scanInstructions: strings.scanInstructions,
          scanButton: false,
        });
        return result.ScanResult || null;
      } catch {
        return null;
      }
    },

    watchPairLinks(onLink) {
      let disposed = false;
      let handle: { remove(): Promise<void> } | null = null;
      void (async () => {
        try {
          const { App } = await import('@capacitor/app');
          const next = await App.addListener('appUrlOpen', ({ url }) => {
            if (!disposed && isPairLink(url)) onLink(url);
          });
          if (disposed) void next.remove();
          else handle = next;
        } catch {
          // Plugin not installed in this shell.
        }
      })();
      return () => {
        disposed = true;
        if (handle) void handle.remove();
      };
    },

    async launchLink() {
      try {
        const { App } = await import('@capacitor/app');
        const result = await App.getLaunchUrl();
        const url = result?.url;
        if (!url || !isPairLink(url)) return null;
        const stored = readJson<{ last: string; handled: string[] }>(STORAGE_KEYS.pairingLaunchLink);
        const handled = Array.isArray(stored?.handled) ? stored.handled.filter((value) => typeof value === 'string') : [];
        if (handledLaunchLinks.has(url) || stored?.last === url || handled.includes(url)) return null;
        handledLaunchLinks.add(url);
        writeJson(STORAGE_KEYS.pairingLaunchLink, { last: url, handled: [...handled, url] });
        return url;
      } catch {
        return null;
      }
    },

    openExternal(url) {
      // Capacitor opens http(s) in the system browser when navigating away.
      window.open(url, '_blank', 'noopener,noreferrer');
    },

    notificationStatus: status,

    async enableNotifications(client) {
      try {
        const { LocalNotifications } = await import('@capacitor/local-notifications');
        const p = await LocalNotifications.requestPermissions();
        writeString(STORAGE_KEYS.localNotifications, null);
        if (p.display === 'granted') {
          await registerActions().catch(() => undefined);
          await sync(client);
        }
      } catch {
        // fall through to status
      }
      return status();
    },

    async disableNotifications(client) {
      writeString(STORAGE_KEYS.localNotifications, 'off');
      await sync(client);
      return status();
    },

    syncReminders: sync,

    init(ctx: PlatformContext) {
      const handles: { remove(): Promise<void> }[] = [];
      let disposed = false;
      const keep = (h: { remove(): Promise<void> }) => {
        if (disposed) void h.remove();
        else handles.push(h);
      };

      void (async () => {
        try {
          const { LocalNotifications } = await import('@capacitor/local-notifications');
          await registerActions().catch(() => undefined);
          keep(
            await LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
              const extra = (event.notification.extra ?? {}) as { reminderId?: unknown; url?: unknown };
              const reminderId = typeof extra.reminderId === 'string' ? extra.reminderId : null;
              if (!reminderId) return;
              if (event.actionId === 'snooze' || event.actionId === 'done') ctx.onReminderAction(reminderId, event.actionId);
              else ctx.openLink(typeof extra.url === 'string' ? extra.url : `neo://reminders/${reminderId}`);
            }),
          );
        } catch {
          // Plugin not installed in this shell.
        }
        try {
          const { App } = await import('@capacitor/app');
          keep(
            await App.addListener('appUrlOpen', ({ url }) => {
              if (isPairLink(url)) ctx.onPairLink(url);
              else ctx.openLink(url);
            }),
          );
          keep(await App.addListener('resume', () => ctx.onResume()));
        } catch {
          // Plugin not installed in this shell.
        }
      })();

      return () => {
        disposed = true;
        for (const h of handles) void h.remove();
      };
    },

    setLocale(locale) {
      const next = locale.toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en;
      if (next !== strings) {
        strings = next;
        void registerActions().catch(() => undefined);
      }
    },
  };
}
