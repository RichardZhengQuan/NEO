import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';
import { NeoConfigSchema, silentLogger } from '@neo/protocol';
import type { NeoServer, NeoServices } from './index.js';
import { startServer } from './server.js';
import { createServices } from './services.js';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { OWNER_TOKEN, routeFixture } from './route-fixture.test-utils.js';

vi.mock('web-push', async (original) => {
  const actual = await original<{ default: typeof import('web-push') }>();
  return { default: { ...actual.default, sendNotification: vi.fn().mockResolvedValue({ statusCode: 201 }) } };
});
const servers: NeoServer[] = [];
const services: NeoServices[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => s.stop()));
  await Promise.all(services.splice(0).map(s => s.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});
async function server(): Promise<NeoServer> {
  const s = await startServer(NeoConfigSchema.parse({ server: { host: '127.0.0.1', port: 0, authToken: OWNER_TOKEN } }), { inMemory: true, logger: silentLogger });
  servers.push(s);
  return s;
}
async function socket(s: NeoServer) {
  const ws = new WebSocket(`${s.url.replace('http:', 'ws:')}/api/ws`);
  const closed = new Promise<Event & { code: number }>(resolve => ws.addEventListener('close', event => resolve(event as Event & { code: number }), { once: true }));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('Socket failed to open')), { once: true });
  });
  return { ws, closed };
}
async function auth(ws: WebSocket, token: string) {
  const ready = new Promise<unknown>(resolve => ws.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true }));
  ws.send(JSON.stringify({ type: 'auth', token }));
  expect(await ready).toMatchObject({ type: 'ready' });
}
const subscription = (endpoint: string) => ({ endpoint, keys: { p256dh: 'offline-public', auth: 'offline-private' } });

describe('security audit regressions', () => {
  it('NEO-02 rotates the owner from disk or config while preserving paired devices', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-rotation-')); dirs.push(dir);
    const boot = async (token?: string) => {
      const s = await createServices(NeoConfigSchema.parse({ dataDir: dir, server: token ? { authToken: token } : {} }), { logger: silentLogger });
      services.push(s); return s;
    };
    const first = await boot();
    const oldToken = first.ownerToken;
    const phone = first.devices.create({ name: 'phone', platform: 'ios' });
    await first.close();
    unlinkSync(join(dir, 'token'));
    const second = await boot();
    expect(second.devices.verify(oldToken)).toBeNull();
    expect(second.devices.verify(second.ownerToken)?.owner).toBe(true);
    expect(second.devices.verify(phone.token)?.id).toBe(phone.device.id);
    await second.close();
    const third = await boot('replacement-owner-token-01234');
    expect(third.devices.verify(second.ownerToken)).toBeNull();
    expect(third.devices.verify(phone.token)?.id).toBe(phone.device.id);
    expect(third.devices.list().filter(d => d.owner)).toHaveLength(1);
  });

  it('NEO-03 revocation closes every device socket with 4401 and removes only its push subscriptions', async () => {
    const s = await server();
    const phone = s.services.devices.create({ name: 'phone', platform: 'ios' });
    const one = await socket(s), two = await socket(s), owner = await socket(s);
    await auth(one.ws, phone.token); await auth(two.ws, phone.token); await auth(owner.ws, OWNER_TOKEN);
    const ownerId = s.services.devices.verify(OWNER_TOKEN)!.id;
    s.services.push.add(subscription('https://fcm.googleapis.com/fcm/send/phone'), phone.device.id);
    s.services.push.add(subscription('https://fcm.googleapis.com/fcm/send/owner'), ownerId);
    expect(s.services.devices.revoke(phone.device.id)).toBe(true);
    expect((await one.closed).code).toBe(4401);
    expect((await two.closed).code).toBe(4401);
    expect(s.services.push.list().map(p => p.deviceId)).toEqual([ownerId]);
    expect(owner.ws.readyState).toBe(WebSocket.OPEN);
  }, 3000);

  it('NEO-03 delivery skips stale subscriptions belonging to revoked devices', async () => {
    const s = await server();
    const phone = s.services.devices.create({ name: 'phone', platform: 'ios' });
    s.services.devices.revoke(phone.device.id);
    s.services.push.add(subscription('https://fcm.googleapis.com/fcm/send/stale'), phone.device.id);
    await s.services.notifier.notify({ kind: 'system', title: 'private', body: 'secret', data: null });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('NEO-10 rejects SSRF push endpoints at subscribe and accepts known push services', async () => {
    const f = routeFixture(); services.push(f.services);
    for (const endpoint of ['https://127.0.0.1/internal', 'http://fcm.googleapis.com/fcm/send/id', 'https://fcm.googleapis.com.evil.test/fcm/send/id', 'https://user:pass@fcm.googleapis.com/fcm/send/id', 'https://fcm.googleapis.com:8443/fcm/send/id', 'https://gmail.googleapis.com/compute/v1/id']) {
      expect((await f.request('/api/push/subscribe', 'POST', { subscription: subscription(endpoint) })).status, endpoint).toBe(400);
    }
    for (const endpoint of ['https://fcm.googleapis.com/fcm/send/id', 'https://android.googleapis.com/gcm/send/id', 'https://updates.push.services.mozilla.com/wpush/v2/id', 'https://web.push.apple.com/id', 'https://wns2-example.notify.windows.com/id']) {
      expect((await f.request('/api/push/subscribe', 'POST', { subscription: subscription(endpoint) })).status, endpoint).toBe(200);
    }
  });

  it('NEO-10 revalidates persisted endpoints at delivery before any outbound call', async () => {
    const s = await server();
    s.services.push.add(subscription('https://127.0.0.1/internal'), s.services.devices.verify(OWNER_TOKEN)!.id);
    await s.services.notifier.notify({ kind: 'system', title: 'private', body: 'secret', data: null });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('NEO-11 rejects unauthenticated frames larger than 64 KiB', async () => {
    const s = await server(), peer = await socket(s);
    peer.ws.send(JSON.stringify({ type: 'auth', token: 'x'.repeat(64 * 1024) }));
    expect((await peer.closed).code).toBe(1009);
  });

  it('NEO-11 caps concurrent unauthenticated sockets per IP and releases slots after auth', async () => {
    const s = await server();
    const pending = [];
    for (let i = 0; i < 5; i++) pending.push(await socket(s));
    const rejected = await socket(s);
    expect((await rejected.closed).code).toBe(4429);
    await auth(pending[0]!.ws, OWNER_TOKEN);
    const accepted = await socket(s);
    await auth(accepted.ws, OWNER_TOKEN);
  }, 3000);

  it('NEO-11 counts oversized unauthenticated frames in the shared failure limiter', async () => {
    const s = await server();
    for (let i = 0; i < 10; i++) {
      const peer = await socket(s);
      peer.ws.send('x'.repeat(64 * 1024 + 1));
      expect((await peer.closed).code).toBe(1009);
    }
    expect((await fetch(`${s.url}/api/settings`, { headers: { Authorization: 'Bearer invalid' } })).status).toBe(429);
  });

  it('NEO-10 custom allowed hosts survive config loading, subscription and delivery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-push-config-')); dirs.push(dir);
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ push: { allowedHosts: ['custom-push.example'] } }));
    const s = await createServices(loadConfig({ path, env: {} }), { inMemory: true, logger: silentLogger }); services.push(s);
    const { app } = createApp(s);
    const phone = s.devices.create({ name: 'phone', platform: 'ios' });
    const endpoint = 'https://custom-push.example/sub';
    const result = await app.request('/api/push/subscribe', { method: 'POST', headers: { Authorization: `Bearer ${phone.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: subscription(endpoint) }) });
    expect(result.status).toBe(200);
    expect(s.push.list()[0]?.deviceId).toBe(phone.device.id);
    await s.notifier.notify({ kind: 'system', title: 'test', body: 'offline', data: null });
    expect(webpush.sendNotification).toHaveBeenCalledWith(subscription(endpoint), expect.any(String), expect.any(Object));
    writeFileSync(path, JSON.stringify({ push: { allowedHosts: ['https://bad.example'] } }));
    expect(() => loadConfig({ path, env: {} })).toThrow();
  });

  it('NEO-11 shares failed WebSocket auth attempts with HTTP without blocking a valid token', async () => {
    const s = await server();
    for (let i = 0; i < 10; i++) {
      const peer = await socket(s);
      peer.ws.send(JSON.stringify({ type: 'auth', token: 'invalid' }));
      expect((await peer.closed).code).toBe(4401);
    }
    expect((await fetch(`${s.url}/api/settings`, { headers: { Authorization: 'Bearer invalid' } })).status).toBe(429);
    expect((await fetch(`${s.url}/api/settings`, { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } })).status).toBe(200);
    const valid = await socket(s); await auth(valid.ws, OWNER_TOKEN);
  });

  it('NEO-12 validates credentials before applying a shared IP failure limit', async () => {
    const f = routeFixture(); services.push(f.services);
    for (let i = 0; i < 10; i++) expect((await f.request('/api/settings', 'GET', undefined, null)).status).toBe(401);
    expect((await f.request('/api/settings', 'GET', undefined, 'invalid')).status).toBe(429);
    expect((await f.request('/api/settings')).status).toBe(200);
  });

  it('NEO-12 honors NEO_TRUST_PROXY with config and override precedence', () => {
    expect(loadConfig({ env: { NEO_TRUST_PROXY: 'true' } }).server.trustProxy).toBe(true);
    expect(loadConfig({ env: { NEO_TRUST_PROXY: 'false' }, overrides: { server: { trustProxy: true } } }).server.trustProxy).toBe(true);
    expect(() => loadConfig({ env: { NEO_TRUST_PROXY: 'not-a-boolean' } })).toThrow();
  });

  it('NEO-12 trusts X-Real-IP only when proxy trust is enabled', async () => {
    const f = routeFixture({ server: { trustProxy: true } }); services.push(f.services);
    for (let i = 0; i < 10; i++) expect((await f.request('/api/settings', 'GET', undefined, null, { 'X-Real-IP': '203.0.113.1' })).status).toBe(401);
    expect((await f.request('/api/settings', 'GET', undefined, null, { 'X-Real-IP': '203.0.113.2' })).status).toBe(401);
  });

  it('NEO-22 compose publishes the API only on loopback by default', () => {
    const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
    const active = compose.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
    expect(active).toContain('"127.0.0.1:7777:7777"');
    expect(active).not.toContain('"7777:7777"');
  });
});
