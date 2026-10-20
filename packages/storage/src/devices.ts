import { createHash } from 'node:crypto';
import {
  newId,
  randomToken,
  type Device,
  type DeviceStore,
  type PushSubscriptionJSON,
  type PushSubscriptionStore,
} from '@neo/protocol';
import { fromJson, toBool, toNum, toNumOrNull, type NeoDatabase } from './db.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

type Row = Record<string, unknown>;
const toDevice = (r: Row): Device => ({
  id: r.id as string,
  name: r.name as string,
  platform: r.platform as Device['platform'],
  createdAt: toNum(r.created_at),
  lastSeenAt: toNumOrNull(r.last_seen_at),
  owner: toBool(r.owner),
});

/** Storage-only additions; the public protocol DeviceStore remains unchanged. */
export interface StorageDeviceStore extends DeviceStore {
  replaceOwner(token: string): ReturnType<DeviceStore['create']>;
  onRevoke(listener: (deviceId: string) => void): () => void;
}

/**
 * Device tokens. Only SHA-256 hashes are stored; lookup is by hash, so the
 * comparison never touches the secret byte-by-byte.
 */
export function createDeviceStore(db: NeoDatabase): StorageDeviceStore {
  const listeners = new Set<(deviceId: string) => void>();
  const emitRevoke = (id: string) => {
    for (const listener of listeners) {
      try { listener(id); } catch {}
    }
  };
  const store: StorageDeviceStore = {
    list() {
      return (db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY owner DESC, created_at ASC').all() as Row[]).map(toDevice);
    },
    create(input) {
      const token = input.token ?? randomToken();
      const now = Date.now();
      const id = newId('dev', now);
      db.prepare(
        'INSERT INTO devices (id, name, platform, token_hash, owner, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)',
      ).run(id, input.name, input.platform, hashToken(token), input.owner ? 1 : 0, now);
      return { device: { id, name: input.name, platform: input.platform, createdAt: now, lastSeenAt: null, owner: Boolean(input.owner) }, token };
    },
    verify(token) {
      if (!token) return null;
      const row = db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(hashToken(token)) as Row | undefined;
      if (!row) return null;
      const now = Date.now();
      // Throttle writes: only touch last_seen_at once a minute.
      if (toNumOrNull(row.last_seen_at) === null || now - toNum(row.last_seen_at) > 60_000) {
        db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, row.id as string);
        row.last_seen_at = now;
      }
      return toDevice(row);
    },
    revoke(id) {
      let revoked = false;
      db.transaction(() => {
        const changed = Number(db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND owner = 0 AND revoked_at IS NULL').run(Date.now(), id).changes) > 0;
        if (changed) {
          db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(id);
          db.afterCommit(() => emitRevoke(id));
        }
        revoked = changed;
      });
      return revoked;
    },
    replaceOwner(token) {
      if (!token) throw new Error('Owner token must not be empty.');
      let owner: ReturnType<DeviceStore['create']>;
      db.transaction(() => {
        const previous = db.prepare('SELECT id FROM devices WHERE owner = 1 AND revoked_at IS NULL').all() as { id: string }[];
        db.prepare('DELETE FROM push_subscriptions WHERE device_id IN (SELECT id FROM devices WHERE owner = 1)').run();
        db.prepare('UPDATE devices SET revoked_at = ? WHERE owner = 1 AND revoked_at IS NULL').run(Date.now());
        // An explicitly reused former owner token still gets a fresh row; paired tokens cannot be promoted.
        db.prepare('DELETE FROM devices WHERE token_hash = ? AND owner = 1 AND revoked_at IS NOT NULL').run(hashToken(token));
        owner = store.create({ name: 'owner', platform: 'other', owner: true, token });
        const revokedIds = previous.map((device) => device.id);
        db.afterCommit(() => { for (const id of revokedIds) emitRevoke(id); });
      });
      return owner!;
    },
    onRevoke(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return store;
}

export function createPushSubscriptionStore(db: NeoDatabase): PushSubscriptionStore {
  return {
    list() {
      return (db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all() as Row[]).map((r) => ({
        id: r.id as string,
        subscription: fromJson<PushSubscriptionJSON>(r.data, { endpoint: r.endpoint as string, keys: { p256dh: '', auth: '' } }),
        deviceId: (r.device_id as string | null) ?? null,
        createdAt: toNum(r.created_at),
      }));
    },
    add(subscription, deviceId = null) {
      const id = newId('push');
      db.prepare(
        `INSERT INTO push_subscriptions (id, endpoint, data, device_id, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET data = excluded.data, device_id = excluded.device_id`,
      ).run(id, subscription.endpoint, JSON.stringify(subscription), deviceId, Date.now());
      const row = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(subscription.endpoint) as { id: string };
      return row.id;
    },
    remove(endpoint) {
      return Number(db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes) > 0;
    },
  };
}
