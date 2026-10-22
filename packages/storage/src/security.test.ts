import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceStore } from '@neo/protocol';
import {
  createDeviceStore, createProviderConfigStore, createPushSubscriptionStore,
  createSecretStore, openNeoDatabase, type NeoDatabase,
} from './index.js';

let db: NeoDatabase;
afterEach(() => db?.close());

describe('device credential security', () => {
  it('replaces every old owner token atomically while preserving paired devices', () => {
    db = openNeoDatabase(':memory:');
    const devices = createDeviceStore(db) as DeviceStore & {
      replaceOwner(token: string): ReturnType<DeviceStore['create']>;
    };
    devices.create({ name: 'owner one', platform: 'other', owner: true, token: 'old-owner-one' });
    devices.create({ name: 'owner two', platform: 'other', owner: true, token: 'old-owner-two' });
    const phone = devices.create({ name: 'phone', platform: 'ios' });
    devices.replaceOwner('new-owner');
    expect(devices.verify('old-owner-one')).toBeNull();
    expect(devices.verify('old-owner-two')).toBeNull();
    expect(devices.verify('new-owner')).toMatchObject({ owner: true });
    expect(devices.verify(phone.token)?.id).toBe(phone.device.id);
    expect(devices.list().filter((device) => device.owner)).toHaveLength(1);
    db.exec("CREATE TRIGGER refuse_owner BEFORE INSERT ON devices WHEN NEW.owner = 1 BEGIN SELECT RAISE(ABORT, 'refused'); END");
    expect(() => devices.replaceOwner('rejected-owner')).toThrow('refused');
    expect(devices.verify('new-owner')).toMatchObject({ owner: true });
  });

  it('deletes device push subscriptions on revoke and emits only committed revocations', () => {
    db = openNeoDatabase(':memory:');
    const devices = createDeviceStore(db) as DeviceStore & { onRevoke(listener: (id: string) => void): () => void };
    const phone = devices.create({ name: 'phone', platform: 'ios' });
    const other = devices.create({ name: 'desktop', platform: 'desktop' });
    const push = createPushSubscriptionStore(db);
    push.add({ endpoint: 'https://fcm.googleapis.com/fcm/send/phone', keys: { p256dh: 'a', auth: 'b' } }, phone.device.id);
    push.add({ endpoint: 'https://fcm.googleapis.com/fcm/send/desktop', keys: { p256dh: 'a', auth: 'b' } }, other.device.id);
    expect(devices.revoke(phone.device.id)).toBe(true);
    expect(push.list().map((item) => item.deviceId)).toEqual([other.device.id]);
    const listener = vi.fn();
    const unsubscribe = devices.onRevoke(listener);
    expect(devices.revoke(other.device.id)).toBe(true);
    expect(listener).toHaveBeenCalledExactlyOnceWith(other.device.id);
    expect(devices.revoke(other.device.id)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('revoke under outer-transaction rollback does not notify', () => {
    db = openNeoDatabase(':memory:');
    const devices = createDeviceStore(db);
    const { device, token } = devices.create({ name: 'phone', platform: 'ios' });
    const notifications: string[] = [];
    devices.onRevoke((id) => notifications.push(id));
    try {
      db.transaction(() => {
        devices.revoke(device.id);
        throw new Error('abort');
      });
    } catch {}
    expect(notifications).toEqual([]);
    expect(devices.verify(token)).toBeTruthy();
  });

  it('replaceOwner under outer-transaction rollback does not notify', () => {
    db = openNeoDatabase(':memory:');
    const devices = createDeviceStore(db);
    devices.create({ name: 'owner', platform: 'other', owner: true, token: 'owner-token' });
    const notifications: string[] = [];
    devices.onRevoke((id) => notifications.push(id));
    try {
      db.transaction(() => {
        devices.replaceOwner('new-owner-token');
        throw new Error('abort');
      });
    } catch {}
    expect(notifications).toEqual([]);
    expect(devices.verify('owner-token')).toBeTruthy();
  });
});

describe('provider custom header security', () => {
  it('rejects missing encrypted header references instead of converting them into literal credentials', () => {
    db = openNeoDatabase(':memory:');
    const secrets = createSecretStore(db, new Uint8Array(32).fill(7));
    const providers = createProviderConfigStore(db, secrets);
    expect(() => providers.upsert({
      id: 'custom', kind: 'mock', enabled: true,
      headers: { 'x-api-key': 'neo-secret:provider:custom:header:x-api-key' },
    })).toThrow('Missing encrypted header');
    expect(secrets.list()).toEqual([]);
    expect(providers.list()).toEqual([]);
  });

  it('rejects case-insensitive duplicate credential header names without storing either value', () => {
    db = openNeoDatabase(':memory:');
    const secrets = createSecretStore(db, new Uint8Array(32).fill(7));
    const providers = createProviderConfigStore(db, secrets);
    expect(() => providers.upsert({
      id: 'custom', kind: 'mock', enabled: true,
      headers: { Authorization: 'first-credential', authorization: 'second-credential' },
    })).toThrow('Duplicate credential header');
    expect(secrets.list()).toEqual([]);
    expect(providers.list()).toEqual([]);
  });

  it('encrypts credential headers and stores only references without changing benign headers', () => {
    db = openNeoDatabase(':memory:');
    const secrets = createSecretStore(db, new Uint8Array(32).fill(7));
    const providers = createProviderConfigStore(db, secrets);
    const headers = {
      Authorization: 'Bearer owner-secret', 'x-goog-api-key': 'google-secret',
      'X-Session-Token': 'session-secret', 'X-Region': 'us-east',
    };
    const stored = providers.upsert({ id: 'custom', kind: 'mock', enabled: true, headers });
    expect(stored.headers?.['x-goog-api-key']).toBe('neo-secret:provider:custom:header:x-goog-api-key');
    expect(stored.headers?.['X-Region']).toBe('us-east');
    expect(secrets.get('provider:custom:header:x-goog-api-key')).toBe('google-secret');
    const raw = db.prepare('SELECT config FROM provider_configs').get() as { config: string };
    expect(raw.config).not.toMatch(/owner-secret|google-secret|session-secret/);
    expect(providers.delete('custom')).toBe(true);
    expect(secrets.list()).toEqual([]);
  });

  it('migrates legacy plaintext credential headers before returning persisted configs', () => {
    db = openNeoDatabase(':memory:');
    const secrets = createSecretStore(db, new Uint8Array(32).fill(7));
    const legacy = { id: 'legacy', kind: 'mock', enabled: true, headers: { 'api-key': 'legacy-secret' } };
    db.prepare('INSERT INTO provider_configs VALUES (?, ?, ?, ?, ?)').run('legacy', JSON.stringify(legacy), 1, 1, 1);
    const providers = createProviderConfigStore(db, secrets);
    expect(providers.list()[0]?.headers?.['api-key']).toBe('neo-secret:provider:legacy:header:api-key');
    expect(secrets.get('provider:legacy:header:api-key')).toBe('legacy-secret');
    expect((db.prepare('SELECT config FROM provider_configs').get() as { config: string }).config).not.toContain('legacy-secret');
  });
});
