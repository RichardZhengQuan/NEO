/**
 * Desktop (Electron) bridge. The preload exposes `window.neoDesktop`
 * ({ getConfig, platform, openExternal }). OS notifications for reminders are
 * shown by the Electron main process (it listens to the server itself), so the
 * renderer never shows them — that would double every reminder.
 */
import type { NeoDesktopBridge } from '../connection.js';
import type { NotificationStatus, PlatformBridge, PlatformContext } from './types.js';

const OS_MANAGED: NotificationStatus = { channel: 'os', permission: 'granted', enabled: true };

export function createElectronBridge(desktop: NeoDesktopBridge): PlatformBridge {
  return {
    kind: 'electron',
    devicePlatform: 'desktop',

    deviceName() {
      if (desktop.platform === 'darwin') return 'Mac';
      if (desktop.platform === 'win32') return 'Windows PC';
      return 'Linux desktop';
    },

    openExternal(url) {
      if (!/^(https?:|mailto:|tel:)/i.test(url)) return;
      void Promise.resolve(desktop.openExternal(url)).catch(() => undefined);
    },

    async notificationStatus() {
      return OS_MANAGED;
    },
    async enableNotifications() {
      return OS_MANAGED;
    },
    async disableNotifications() {
      return OS_MANAGED;
    },
    async syncReminders() {
      // The main process notifies; nothing to schedule here.
    },

    watchPairLinks(onLink) {
      return desktop.watchPairLinks?.(onLink) ?? (() => {});
    },

    init(ctx: PlatformContext) {
      // Notification clicks are routed by the main process by setting the hash.
      const onFocus = () => ctx.onResume();
      window.addEventListener('focus', onFocus);
      const offPairLinks = desktop.watchPairLinks?.((url) => ctx.onPairLink(url)) ?? (() => {});
      return () => {
        window.removeEventListener('focus', onFocus);
        offPairLinks();
      };
    },

    setLocale() {
      // The main process formats its own notifications.
    },
  };
}
