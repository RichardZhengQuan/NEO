import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';
import { silentLogger } from '@neo/protocol';
import { createConversationStore, createPushSubscriptionStore, migrate, openNeoDatabase } from '@neo/storage';
import type { NeoDatabase } from '@neo/storage';
import { createProductivityStores, toolsMigrations } from '@neo/tools';
import { EventHub } from './events.js';
import { createNotifier, loadOrCreateVapidKeys } from './notifier.js';

vi.mock('web-push', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('web-push') }>();
  return { default: { ...actual.default, sendNotification: vi.fn() } };
});

let db: NeoDatabase | null = null;
const directories: string[] = [];
afterEach(() => {
  db?.close();
  db = null;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('notifications and Web Push', () => {
  it('stores before publishing and delivery; removes 404/410 subscriptions and preserves transient failures', async () => {
    db = openNeoDatabase(':memory:');
    migrate(db, 'tools', toolsMigrations);
    const notifications = createProductivityStores(db, { clock: () => 1234 }).notifications;
    const push = createPushSubscriptionStore(db);
    for (const endpoint of ['https://fcm.googleapis.com/fcm/send/gone', 'https://fcm.googleapis.com/fcm/send/expired', 'https://fcm.googleapis.com/fcm/send/retry']) {
      push.add({ endpoint, keys: { p256dh: 'test-key', auth: 'test-auth' } });
    }
    const events = new EventHub(() => 1234);
    const keys = webpush.generateVAPIDKeys();
    const send = vi.mocked(webpush.sendNotification);
    send.mockRejectedValueOnce({ statusCode: 404 }).mockRejectedValueOnce({ statusCode: 410 }).mockRejectedValueOnce({ statusCode: 502 });
    events.subscribe((envelope) => {
      expect(notifications.list()).toHaveLength(1);
      expect(envelope.event.type).toBe('notification.created');
      expect(send).not.toHaveBeenCalled();
    });
    const notifier = createNotifier({ notifications, push, events, clock: () => 1234, logger: silentLogger, vapidKeys: keys, pushSubject: 'mailto:test@example.com' });
    const input = { kind: 'reminder' as const, title: 'Drink water', body: "It's time", data: { reminderId: 'reminder-test', url: 'neo://reminders/reminder-test' } };
    const notification = await notifier.notify(input);
    expect(notification).toMatchObject({ ...input, createdAt: 1234, readAt: null });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]?.[2]).toEqual({ vapidDetails: { subject: 'mailto:test@example.com', ...keys }, timeout: 10_000 });
    expect(JSON.parse(String(send.mock.calls[0]?.[1]))).toEqual({ title: input.title, body: input.body, data: input.data });
    expect(push.list().map((entry) => entry.subscription.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/retry']);
  });

  it('creates and reloads private VAPID files, and keeps in-memory key creation file-free', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-server-vapid-'));
    directories.push(directory);
    const keys = loadOrCreateVapidKeys(directory);
    expect(loadOrCreateVapidKeys(directory)).toEqual(keys);
    expect(statSync(join(directory, 'vapid.json')).mode & 0o777).toBe(0o600);
    const absent = join(directory, 'memory-only');
    expect(loadOrCreateVapidKeys(absent, undefined, { inMemory: true })).toHaveProperty('publicKey');
    expect(existsSync(absent)).toBe(false);
    expect(loadOrCreateVapidKeys(absent, { vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey })).toEqual(keys);
    expect(existsSync(absent)).toBe(false);
  });
});


it('notification payloads target timeline message ids and convert legacy conversation links', async () => {
  db = openNeoDatabase(':memory:');
  migrate(db, 'tools', toolsMigrations);
  const conversations = createConversationStore(db, { clock: () => 1234 });
  const episode = conversations.createEpisode();
  conversations.appendMessage({ id: 'source-message', conversationId: episode.id, role: 'assistant', createdAt: 1234, status: 'complete', parts: [] });
  const notifications = createProductivityStores(db).notifications;
  const events = new EventHub();
  const notifier = createNotifier({ notifications, conversations, push: createPushSubscriptionStore(db), events, clock: () => 1234, logger: silentLogger, vapidKeys: null, pushSubject: 'mailto:test@example.com' });
  const current = await notifier.notify({ kind: 'reminder', title: 'Current', body: 'Details', data: { messageId: 'source-message', reminderId: 'reminder' } });
  expect(current.data).toEqual({ messageId: 'source-message', reminderId: 'reminder', url: 'neo://timeline/source-message' });
  const legacy = await notifier.notify({ kind: 'reminder', title: 'Legacy', body: 'Details', data: { conversationId: episode.id, url: `neo://chat/${episode.id}` } });
  expect(legacy.data).toEqual({ messageId: 'source-message', url: 'neo://timeline/source-message' });
  expect(events.since(0)).toHaveLength(2);
});
