import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_ACTIVE_PAIRING_CODES, PAIRING_CODE_TTL_MS, parsePairingLink, randomToken } from '@neo/protocol';
import type { ClaimPairingResponse, PairingSession, ServerEvent } from '@neo/protocol';
import { createApp } from './app.js';
import { PairingService } from './pairing.js';
import { OWNER_TOKEN, routeFixture } from './route-fixture.test-utils.js';

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
}

describe('pairing HTTP API', () => {
  let f: ReturnType<typeof routeFixture>;
  beforeEach(() => { f = routeFixture(); });
  afterEach(async () => { await f.services.close(); });

  const create = async () => json<PairingSession>(await f.request('/api/pairing', 'POST'), 201);
  const claim = (code: string, headers: Record<string, string> = {}) => f.request('/api/pairing/claim', 'POST', {
    code, deviceName: 'My phone', platform: 'ios',
  }, null, headers);

  it('lets the owner create a v2 code with the request origin and injected expiry', async () => {
    const session = await json<PairingSession>(await f.request('https://computer.example:7777/api/pairing', 'POST', { ignored: true }), 201);
    expect(session.id).toMatch(/^pair_/);
    expect(session.code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(session.expiresAt).toBe(f.time.now + PAIRING_CODE_TTL_MS);
    expect(parsePairingLink(session.pairingUrl)).toEqual({
      version: 2, code: session.code, serverUrl: 'https://computer.example:7777', tunnel: null,
    });
  });

  it('uses publicUrl when configured instead of the request origin or Origin header', async () => {
    f.services.config.server.publicUrl = 'https://neo.example/base';
    const session = await json<PairingSession>(await f.request('/api/pairing', 'POST', undefined, OWNER_TOKEN, { Origin: 'https://attacker.example' }), 201);
    expect(parsePairingLink(session.pairingUrl)?.serverUrl).toBe('https://neo.example/base');
  });

  it('refuses create and cancel for a paired non-owner device', async () => {
    const session = await create();
    const paired = f.services.devices.create({ name: 'Existing phone', platform: 'android', owner: false });
    expect((await f.request('/api/pairing', 'POST', undefined, paired.token)).status).toBe(403);
    expect((await f.request(`/api/pairing/${session.id}`, 'DELETE', undefined, paired.token)).status).toBe(403);
    expect((await claim(session.code)).status).toBe(201);
  });

  it('claims without a bearer token, authenticates with the returned device token and publishes the pairing id', async () => {
    const session = await create();
    const events: ServerEvent[] = [];
    const unsubscribe = f.services.events.subscribe((envelope) => events.push(envelope.event));
    try {
      const paired = await json<ClaimPairingResponse>(await claim(session.code), 201);
      expect(paired.device).toMatchObject({ name: 'My phone', platform: 'ios', owner: false });
      expect(events).toEqual([{ type: 'device.paired', device: paired.device, pairingId: session.id }]);
      const listed = await json<{ items: ClaimPairingResponse['device'][] }>(await f.request('/api/devices', 'GET', undefined, paired.token));
      expect(listed.items.find((device) => device.id === paired.device.id)).toMatchObject({
        ...paired.device, lastSeenAt: expect.any(Number),
      });
    } finally { unsubscribe(); }
  });

  it('allows a code to be used only once', async () => {
    const session = await create();
    expect((await claim(session.code)).status).toBe(201);
    expect(await json(await claim(session.code), 401)).toMatchObject({
      code: 'unauthorized', message: 'This pairing code is invalid or has expired.',
    });
  });

  it('consumes the code synchronously before concurrent claims can reuse it', async () => {
    const session = await create();
    const responses = await Promise.all([claim(session.code), claim(session.code)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 401]);
    expect(f.services.devices.list().filter((device) => !device.owner)).toHaveLength(1);
  });

  it('rejects an expired code using the injected clock', async () => {
    const session = await create();
    f.time.now = session.expiresAt + 1;
    expect((await claim(session.code)).status).toBe(401);
  });

  it('cancels unclaimed codes and reports unknown ids', async () => {
    const session = await create();
    expect((await f.request(`/api/pairing/${session.id}`, 'DELETE')).status).toBe(204);
    expect((await claim(session.code)).status).toBe(401);
    expect(await json(await f.request('/api/pairing/missing', 'DELETE'), 404)).toMatchObject({ code: 'not_found' });
  });

  it('drops the oldest code when creating a sixth code', async () => {
    const sessions: PairingSession[] = [];
    for (let i = 0; i <= MAX_ACTIVE_PAIRING_CODES; i++) sessions.push(await create());
    expect((await claim(sessions[0]!.code)).status).toBe(401);
    for (const session of sessions.slice(1)) expect((await claim(session.code)).status).toBe(201);
  });

  it('returns 400 for malformed bodies without consuming a valid code or counting failures', async () => {
    const session = await create();
    for (let i = 0; i < 10; i++) {
      expect((await f.request('/api/pairing/claim', 'POST', { code: session.code, deviceName: '', platform: 'ios' }, null)).status).toBe(400);
    }
    expect((await f.request('/api/pairing/claim', 'POST', { code: 'short', deviceName: 'Phone' }, null)).status).toBe(400);
    expect((await f.request('/api/pairing/claim', 'POST', { code: session.code, deviceName: 'Phone', platform: 'unsupported' }, null)).status).toBe(400);
    expect((await f.app.request('/api/pairing/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400);
    expect((await claim(session.code)).status).toBe(201);
  });

  it('enforces the public claim route body limit independently of the global limit', async () => {
    const session = await create();
    expect((await f.request('/api/pairing/claim', 'POST', { code: session.code, deviceName: 'Phone', extra: 'x'.repeat(4096) }, null)).status).toBe(400);
    expect((await claim(session.code)).status).toBe(201);
  });

  it('blocks even valid codes after ten IP failures, then allows them after 60 seconds', async () => {
    f.services.config.server.trustProxy = true;
    const session = await create();
    const headers = { 'X-Forwarded-For': '192.0.2.1' };
    for (let i = 0; i < 10; i++) expect((await claim(randomToken(24), headers)).status).toBe(401);
    const limited = await claim(session.code, headers);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(await limited.json()).toMatchObject({ code: 'rate_limited', retryable: true });
    expect((await f.request('/api/pairing/claim', 'POST', {}, null, headers)).status).toBe(429);
    const otherSession = await create();
    expect((await claim(otherSession.code, { 'X-Forwarded-For': '192.0.2.2' })).status).toBe(201);
    expect((await f.request('/api/devices', 'GET', undefined, null, headers)).status).toBe(401);
    f.time.now += 60_000;
    expect((await claim(session.code, headers)).status).toBe(201);
  });

  it('keeps pairing codes scoped to the app even when services are shared', async () => {
    const session = await create();
    const { app } = createApp(f.services);
    const response = await app.request('/api/pairing/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: session.code, deviceName: 'Phone', platform: 'ios' }),
    });
    expect(response.status).toBe(401);
    expect((await claim(session.code)).status).toBe(201);
  });
});

describe('PairingService', () => {
  it('prunes expiry on create and cancel as well as claim', () => {
    let now = 0;
    const pairing = new PairingService(() => now);
    const expired = pairing.create();
    now = expired.expiresAt;
    expect(pairing.cancel(expired.id)).toBe(false);
    const next = pairing.create();
    expect(pairing.claim(expired.code)).toBeNull();
    expect(pairing.claim(next.code)).toEqual({ id: next.id });
    expect(pairing.cancel(next.id)).toBe(false);
  });
});
