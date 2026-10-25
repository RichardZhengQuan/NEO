import { once } from 'node:events';
import { Server } from 'node:http';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoError } from '@neo/protocol';
import { createAuthMiddleware } from '../auth.js';
import { createChatGPTAuthorization } from '../chatgpt-auth.js';
import type { NeoServices } from '../index.js';
import { registerChatGPT } from './chatgpt.js';

vi.mock('../chatgpt-auth.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../chatgpt-auth.js')>(),
  createChatGPTAuthorization: vi.fn(() => 'https://example.test/authorize'),
}));

const OWNER_TOKEN = 'owner-token-for-chatgpt-route-tests';

function fixture() {
  const time = { now: Date.parse('2026-10-25T12:00:00Z') };
  const secrets = new Map<string, string>();
  const services = {
    config: { mode: 'local' },
    clock: () => time.now,
    providerConfigs: { list: () => [] },
    secrets: { get: (key: string) => secrets.get(key), set: (key: string, value: string) => secrets.set(key, value) },
    devices: { verify: (token: string) => token === OWNER_TOKEN ? { id: 'owner', owner: true } : null },
    close: async () => {},
  } as unknown as NeoServices;
  const app = new Hono();
  app.onError((error) => {
    const neo = NeoError.from(error);
    return new Response(JSON.stringify(neo.toJSON()), { status: neo.status, headers: { 'Content-Type': 'application/json' } });
  });
  app.use('/api/*', createAuthMiddleware(services.devices, false, services.clock));
  registerChatGPT(app, services);
  const mapSet = vi.spyOn(Map.prototype, 'set');
  const request = (body?: string) => app.request('/api/auth/chatgpt/start', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OWNER_TOKEN}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body } : {}),
  });
  return { services, time, mapSet, request };
}

let f: ReturnType<typeof fixture>;

function attemptMap() {
  // Capture the real private map without changing its operations or exporting a test hook.
  const index = f.mapSet.mock.calls.findIndex(([state, value]) => value && typeof value === 'object' && value.state === state && value.server instanceof Server);
  return f.mapSet.mock.contexts[index] as Map<string, { server: Server }> | undefined;
}

beforeEach(() => {
  vi.mocked(createChatGPTAuthorization).mockReset().mockReturnValue('https://example.test/authorize');
  f = fixture();
});

afterEach(async () => {
  const closed = [...(attemptMap()?.values() ?? [])]
    .filter(attempt => attempt.server.listening)
    .map(attempt => once(attempt.server, 'close'));
  try {
    await f.services.close();
    await Promise.all(closed);
  } finally {
    vi.restoreAllMocks();
  }
});

describe('POST /api/auth/chatgpt/start listener cap', () => {
  it('keeps attempts.size at most 100 for 150 concurrent owner-authenticated starts', async () => {
    const results = await Promise.allSettled(Array.from({ length: 150 }, () => f.request()));
    const attempts = attemptMap();

    expect(attempts).toBeDefined();
    expect(attempts!.size).toBeLessThanOrEqual(100);
    const responses = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    expect(responses).toHaveLength(150);
    expect(responses.filter(response => response.status === 200)).toHaveLength(100);
    expect(responses.filter(response => response.status === 429)).toHaveLength(50);
  });

  it('allows all 100 slots sequentially and restores capacity after pruning', async () => {
    for (let i = 0; i < 100; i++) expect((await f.request()).status).toBe(200);
    expect((await f.request()).status).toBe(429);
    expect(attemptMap()?.size).toBe(100);

    const pruned = [...attemptMap()!.values()].map(attempt => once(attempt.server, 'close'));
    f.time.now += 20 * 60_000;
    expect((await f.request()).status).toBe(200);
    await Promise.all(pruned);
    for (let i = 1; i < 100; i++) expect((await f.request()).status).toBe(200);
    expect((await f.request()).status).toBe(429);
    expect(attemptMap()?.size).toBe(100);
  });

  it('releases reservations when request validation fails before creating a state', async () => {
    for (let i = 0; i < 150; i++) expect((await f.request('invalid-json')).status).toBe(400);

    expect((await f.request()).status).toBe(200);
    expect(attemptMap()?.size).toBe(1);
  });
});
