import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { migrate, openNeoDatabase, type NeoDatabase } from '@neo/storage';
import { createNotificationStore } from './notifications.js';
import { toolsMigrations } from './index.js';

const databases: NeoDatabase[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function database(path = ':memory:') {
  const db = openNeoDatabase(path);
  migrate(db, 'tools', toolsMigrations);
  databases.push(db);
  return db;
}
const input = { kind: 'reminder' as const, title: 'Original', body: 'Original body', data: { reminderId: 'reminder' }, createdAt: 10 };

it('atomically preserves the first notification and read state across store connections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-notification-once-'));
  directories.push(dir);
  const path = join(dir, 'neo.db');
  const first = createNotificationStore(database(path), { clock: () => 20 });
  const second = createNotificationStore(database(path), { clock: () => 40 });
  const created = first.createOnce('opaque/firing?identity', input);
  expect(created.created).toBe(true);
  expect(created.notification.id.length).toBeLessThan(64);
  expect(created.notification.id).not.toContain('opaque');
  expect(first.markRead([created.notification.id])).toBe(1);
  const replay = second.createOnce('opaque/firing?identity', { ...input, title: 'Changed', body: 'Changed', data: null, createdAt: 99 });
  expect(replay).toEqual({ created: false, notification: { ...created.notification, readAt: 20 } });
  expect(first.list()).toEqual([replay.notification]);
  expect(second.list({ unread: true })).toEqual([]);
});

it('keeps distinct firing identities and ordinary notifications independent', () => {
  const store = createNotificationStore(database());
  const first = store.createOnce('firing-1', input);
  const next = store.createOnce('firing-2', input);
  const ordinary = [store.create(input), store.create(input)];
  expect(next.created).toBe(true);
  expect(new Set([first.notification.id, next.notification.id, ...ordinary.map(n => n.id)]).size).toBe(4);
  expect(store.list()).toHaveLength(4);
});

it('does not reserve an identity when notification validation fails', () => {
  const store = createNotificationStore(database());
  expect(() => store.createOnce('retry', { ...input, title: 'x'.repeat(1001) })).toThrow();
  expect(store.list()).toEqual([]);
  expect(store.createOnce('retry', input).created).toBe(true);
});
