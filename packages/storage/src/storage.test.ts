import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId, type Message } from '@neo/protocol';
import {
  blobToVector,
  createConversationStore,
  createDeviceStore,
  createProviderConfigStore,
  createPushSubscriptionStore,
  createSecretStore,
  createSettingsStore,
  ftsQuery,
  loadOrCreateKey,
  migrate,
  openNeoDatabase,
  vectorToBlob,
  type NeoDatabase,
} from './index.js';

let db: NeoDatabase;
afterEach(() => db?.close());

describe('database', () => {
  it('migrates idempotently and supports nested transactions', () => {
    db = openNeoDatabase(':memory:');
    const again = migrate(db, 'storage', []);
    expect(again.applied).toEqual([]);
    db.exec('CREATE TABLE t (x INTEGER)');
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (1)').run();
        try {
          db.transaction(() => {
            db.prepare('INSERT INTO t VALUES (2)').run();
            throw new Error('inner');
          });
        } catch {
          /* inner rolled back */
        }
        db.prepare('INSERT INTO t VALUES (3)').run();
        throw new Error('outer');
      }),
    ).toThrow('outer');
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
    db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (1)').run();
      try {
        db.transaction(() => {
          db.prepare('INSERT INTO t VALUES (2)').run();
          throw new Error('inner');
        });
      } catch {
        /* ignore */
      }
    });
    expect(db.prepare('SELECT x FROM t').all()).toEqual([{ x: 1 }]);
  });

  it('round-trips vectors and builds safe fts queries', () => {
    const v = new Float32Array([0.5, -1.25, 3]);
    expect(Array.from(blobToVector(vectorToBlob(v)))).toEqual([0.5, -1.25, 3]);
    expect(ftsQuery('Hello "world" a')).toBe('"hello" OR "world"');
    expect(ftsQuery('!!')).toBeNull();
  });
});

describe('conversation store', () => {
  it('creates, appends, paginates, searches and deletes', () => {
    db = openNeoDatabase(':memory:');
    let t = 1000;
    const store = createConversationStore(db, { clock: () => t++ });
    const c = store.create({ title: 'Kyoto trip' });
    const mk = (i: number, text: string): Message => ({
      id: newId('msg'),
      conversationId: c.id,
      role: i % 2 ? 'assistant' : 'user',
      parts: [{ type: 'text', text }],
      createdAt: 2000 + i,
      status: 'complete',
    });
    for (let i = 0; i < 5; i++) store.appendMessage(mk(i, `message ${i}`));
    expect(store.messages(c.id)).toHaveLength(5);
    const last2 = store.messages(c.id, { limit: 2 });
    expect(last2.map((m) => m.parts[0])).toEqual([
      { type: 'text', text: 'message 3' },
      { type: 'text', text: 'message 4' },
    ]);
    expect(store.get(c.id)?.preview).toBe('message 4');
    const m = store.messages(c.id)[0]!;
    store.updateMessage(m.id, { status: 'error', error: { code: 'internal', message: 'x' } });
    expect(store.getMessage(m.id)?.error?.code).toBe('internal');
    expect(store.list({ query: 'kyoto' })).toHaveLength(1);
    expect(store.list({ query: '100%' })).toHaveLength(0);
    store.update(c.id, { pinned: true, toolset: ['a'] });
    expect(store.get(c.id)).toMatchObject({ pinned: true, toolset: ['a'] });
    expect(store.delete(c.id)).toBe(true);
    expect(store.messages(c.id)).toHaveLength(0);
  });
});

describe('settings, secrets, devices, push, providers', () => {
  it('persists settings with defaults and validates patches', () => {
    db = openNeoDatabase(':memory:');
    const s = createSettingsStore(db);
    let seen = '';
    s.onChange((v) => (seen = v.persona.name));
    s.update({ persona: { name: 'Nova' } });
    expect(seen).toBe('Nova');
    expect(createSettingsStore(db).get().persona.name).toBe('Nova');
    expect(() => s.update({ agent: { maxSteps: -1 } })).toThrow(/Invalid settings/);
  });

  it('encrypts secrets with a persisted key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-'));
    try {
      const key = loadOrCreateKey(join(dir, 'key'));
      expect(loadOrCreateKey(join(dir, 'key')).equals(key)).toBe(true);
      db = openNeoDatabase(join(dir, 'neo.db'));
      const secrets = createSecretStore(db, key);
      secrets.set('provider:anthropic', 'sk-test-123');
      expect(secrets.get('provider:anthropic')).toBe('sk-test-123');
      const raw = db.prepare('SELECT data FROM secrets').get() as { data: Uint8Array };
      expect(Buffer.from(raw.data).toString()).not.toContain('sk-test');
      expect(secrets.list()).toEqual(['provider:anthropic']);
      expect(() => createSecretStore(db, Buffer.alloc(32, 1)).get('provider:anthropic')).toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies and revokes device tokens', () => {
    db = openNeoDatabase(':memory:');
    const devices = createDeviceStore(db);
    const owner = devices.create({ name: 'Owner', platform: 'desktop', owner: true, token: 'owner-token-0123456789' });
    const phone = devices.create({ name: 'Phone', platform: 'ios' });
    expect(devices.verify('owner-token-0123456789')?.id).toBe(owner.device.id);
    expect(devices.verify(phone.token)?.name).toBe('Phone');
    expect(devices.verify('nope')).toBeNull();
    expect(devices.revoke(owner.device.id)).toBe(false);
    expect(devices.revoke(phone.device.id)).toBe(true);
    expect(devices.verify(phone.token)).toBeNull();
    const push = createPushSubscriptionStore(db);
    push.add({ endpoint: 'https://push.example.com/1', keys: { p256dh: 'a', auth: 'b' } });
    push.add({ endpoint: 'https://push.example.com/1', keys: { p256dh: 'c', auth: 'd' } });
    expect(push.list()).toHaveLength(1);
    expect(push.list()[0]!.subscription.keys.p256dh).toBe('c');
    const providers = createProviderConfigStore(db);
    providers.upsert({ id: 'ollama', kind: 'ollama', enabled: true });
    expect(providers.list()[0]!.kind).toBe('ollama');
    expect(providers.delete('ollama')).toBe(true);
  });
});
