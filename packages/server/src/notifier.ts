/** Persist notifications, publish them, and deliver optional Web Push. */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import { NeoError } from '@neo/protocol';
import type { Clock, ConversationStore, DeviceStore, Logger, Notification, NotificationStore, PushSubscriptionStore } from '@neo/protocol';
import type { Notifier } from './index.js';
import type { EventHub } from './events.js';
import { isAllowedPushEndpoint } from './push-policy.js';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

function isKeys(value: unknown): value is VapidKeys {
  return typeof value === 'object' && value !== null &&
    'publicKey' in value && typeof value.publicKey === 'string' && value.publicKey.length > 0 &&
    'privateKey' in value && typeof value.privateKey === 'string' && value.privateKey.length > 0;
}

/** In-memory services generate keys without reading or writing the filesystem. */
export function loadOrCreateVapidKeys(
  dataDir: string,
  config?: { vapidPublicKey?: string; vapidPrivateKey?: string },
  options: { inMemory?: boolean } = {},
): VapidKeys {
  if (config?.vapidPublicKey && config.vapidPrivateKey) {
    return { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
  }
  try {
    if (options.inMemory) return webpush.generateVAPIDKeys();
    const filePath = join(dataDir, 'vapid.json');
    if (existsSync(filePath)) {
      try {
        const keys: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
        if (isKeys(keys)) {
          chmodSync(filePath, 0o600);
          return keys;
        }
      } catch {
        // Invalid persisted keys are replaced below.
      }
    }
    const keys = webpush.generateVAPIDKeys();
    writeFileSync(filePath, JSON.stringify(keys, null, 2), { mode: 0o600 });
    chmodSync(filePath, 0o600);
    return keys;
  } catch (error) {
    throw NeoError.from(error, 'config_error');
  }
}

export interface NotifierOptions {
  notifications: NotificationStore;
  push: PushSubscriptionStore;
  events: EventHub;
  logger: Logger;
  clock: Clock;
  vapidKeys: VapidKeys | null;
  pushSubject: string;
  devices?: DeviceStore;
  conversations?: ConversationStore;
  allowedHosts?: readonly string[];
}

export function createNotifier(opts: NotifierOptions): Notifier {
  const { notifications, push, events, logger, vapidKeys, pushSubject } = opts;
  return {
    async notify(input, options): Promise<Notification> {
      let stored: Notification;
      try {
        const data = input.data ? { ...input.data } : null;
        if (data && typeof data.conversationId === 'string') {
          const message = opts.conversations?.messages(data.conversationId, { limit: 1 })[0];
          if (typeof data.messageId !== 'string' && message) data.messageId = message.id;
          delete data.conversationId;
        }
        if (data && typeof data.messageId === 'string') data.url = `neo://timeline/${encodeURIComponent(data.messageId)}`;
        const prepared = { ...input, createdAt: input.createdAt ?? opts.clock(), data };
        if (options?.idempotencyKey !== undefined) {
          const result = notifications.createOnce(options.idempotencyKey, prepared);
          stored = result.notification;
          if (!result.created) return stored;
        } else {
          stored = notifications.create(prepared);
        }
      } catch (error) {
        throw NeoError.from(error);
      }
      events.publish({ type: 'notification.created', notification: stored });
      if (!vapidKeys) return stored;

      const payload = JSON.stringify({ title: stored.title, body: stored.body, data: stored.data });
      await Promise.all(push.list().map(async ({ subscription, id, deviceId }) => {
        // Revalidate legacy rows at the outbound boundary and fail closed for
        // revoked or unbound devices when a device store is available.
        if (!isAllowedPushEndpoint(subscription.endpoint, opts.allowedHosts)) return;
        if (opts.devices && (!deviceId || !opts.devices.list().some(device => device.id === deviceId))) return;
        try {
          // VAPID belongs to this server, rather than the library's global state.
          await webpush.sendNotification(subscription, payload, {
            vapidDetails: { subject: pushSubject, ...vapidKeys },
            timeout: 10_000,
          });
        } catch (error) {
          const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : null;
          if (statusCode === 404 || statusCode === 410) {
            try {
              push.remove(subscription.endpoint);
              logger.info('Removed expired push subscription', { id, statusCode });
            } catch (removeError) {
              logger.warn('Failed to remove expired push subscription', { id, error: String(removeError) });
            }
          } else {
            logger.warn('Web Push delivery failed', { id, error: String(error) });
          }
        }
      }));
      return stored;
    },
  };
}
