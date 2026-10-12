import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoConfigSchema, silentLogger, type Logger, type OpenRouterStartResponse, type ProviderView } from '@neo/protocol';
import { createApp } from './app.js';
import { createServices } from './services.js';
import type { NeoServices } from './index.js';

const KEY = 'sk-or-offline-secret-never-returned';
let fake: Server;
let services: NeoServices;
let app: ReturnType<typeof createApp>['app'];
let baseUrl: string;
let now: number;
let upstreamStatus: number;
let modelsStatus: number;
let calls: { path: string; body: Record<string, unknown>; authorization?: string }[];
let logs: unknown[];
let exchangeGate: Promise<void> | undefined;
let releaseExchange: (() => void) | undefined;
let modelsGate: Promise<void> | undefined;
let releaseModels: (() => void) | undefined;
let malformedExchange: boolean;
let malformedModels: boolean;

beforeEach(async () => {
  now = 1_800_000_000_000;
  upstreamStatus = modelsStatus = 200;
  calls = [];
  logs = [];
  exchangeGate = modelsGate = undefined;
  releaseExchange = releaseModels = undefined;
  malformedExchange = malformedModels = false;
  fake = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    calls.push({ path: req.url!, body, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/auth/keys') {
      await exchangeGate;
      if (malformedExchange) { res.end(KEY); return; }
      res.statusCode = upstreamStatus;
      res.end(JSON.stringify(upstreamStatus === 200 ? { key: KEY } : { error: `${KEY} invalid code ${String(body['code_verifier'])}` }));
    } else if (req.url === '/api/v1/models') {
      await modelsGate;
      if (malformedModels) { res.end(KEY); return; }
      res.statusCode = modelsStatus;
      res.end(JSON.stringify(modelsStatus === 200 ? { data: [{ id: 'anthropic/claude-sonnet-5-5' }, { id: 'openai/gpt-5' }] } : { error: { message: `Rejected ${KEY}` } }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve));
  const address = fake.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const record = (msg: string, data?: Record<string, unknown>) => logs.push({ msg, data });
  const logger: Logger = { debug: record, info: record, warn: record, error: record, child: () => logger };
  services = await createServices(NeoConfigSchema.parse({ providers: [], server: { publicUrl: 'http://localhost:9231' }, plugins: { enabled: false }, log: { level: 'silent' } }), {
    inMemory: true, clock: () => now, logger, openRouter: { baseUrl },
  });
  app = createApp(services).app;
});

afterEach(async () => {
  releaseExchange?.();
  releaseModels?.();
  await services?.close();
  await new Promise<void>(resolve => { fake.close(() => resolve()); fake.closeAllConnections(); });
});

function request(path: string, method = 'GET', body?: unknown, token: string | null = services.ownerToken) {
  return app.request(path, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function start() {
  const response = await request('/api/auth/openrouter/start', 'POST');
  expect(response.status).toBe(200);
  return await response.json() as OpenRouterStartResponse;
}

const callback = (state: string, code = 'offline-code') => request(`/api/auth/openrouter/callback?${new URLSearchParams({ state, code })}`, 'GET', undefined, null);

describe('OpenRouter sign-in', () => {
  it('uses the requesting server origin and port when publicUrl is unset', async () => {
    services.config.server.publicUrl = undefined;
    const response = await request('http://localhost:64321/api/auth/openrouter/start', 'POST');
    const attempt = await response.json() as OpenRouterStartResponse;
    expect(new URL(attempt.url).searchParams.get('callback_url')).toBe('http://localhost:64321/api/auth/openrouter/callback');
  });

  it('keeps separate providers for two simultaneous sign-ins', async () => {
    modelsGate = new Promise(resolve => { releaseModels = resolve; });
    const attempts = await Promise.all([start(), start()]);
    const callbacks = attempts.map(attempt => callback(attempt.state));
    await vi.waitFor(() => expect(calls.filter(call => call.path.endsWith('/models'))).toHaveLength(2));
    releaseModels!();
    expect((await Promise.all(callbacks)).map(response => response.status)).toEqual([200, 200]);
    expect(services.providerConfigs.list().map(provider => provider.id).sort()).toEqual(['openrouter', 'openrouter-2']);
    expect(services.secrets.get('provider:openrouter')).toBe(KEY);
    expect(services.secrets.get('provider:openrouter-2')).toBe(KEY);
  });

  it('rejects a concurrent explicit provider-id collision before committing another key', async () => {
    modelsGate = new Promise(resolve => { releaseModels = resolve; });
    const body = { id: 'openrouter', kind: 'openai-compatible', baseUrl, apiKey: KEY, simple: true };
    const requests = [request('/api/providers', 'POST', body), request('/api/providers', 'POST', body)];
    await vi.waitFor(() => expect(calls.filter(call => call.path.endsWith('/models'))).toHaveLength(2));
    releaseModels!();
    expect((await Promise.all(requests)).map(response => response.status).sort()).toEqual([201, 409]);
    expect(services.providerConfigs.list()).toHaveLength(1);
    expect(services.secrets.list()).toEqual(['provider:openrouter']);
  });

  it('cancels an in-flight key exchange without persisting a key or settings', async () => {
    exchangeGate = new Promise(resolve => { releaseExchange = resolve; });
    const before = services.settings.get();
    const attempt = await start();
    const completing = callback(attempt.state);
    await vi.waitFor(() => expect(calls.some(call => call.path.endsWith('/auth/keys'))).toBe(true));
    expect(await (await request('/api/auth/openrouter/cancel', 'POST', { state: attempt.state })).json()).toEqual({ cancelled: true });
    expect((await completing).status).toBe(499);
    releaseExchange!();
    expect(services.providerConfigs.list()).toEqual([]);
    expect(services.secrets.list()).toEqual([]);
    expect(services.settings.get()).toEqual(before);
    expect((await callback(attempt.state)).status).toBe(400);
  });

  it.each(['exchange', 'models'])('does not reflect or log credential-bearing malformed %s JSON', async (stage) => {
    if (stage === 'exchange') malformedExchange = true;
    else malformedModels = true;
    const attempt = await start();
    const response = await callback(attempt.state);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(services.providerConfigs.list()).toEqual([]);
    expect(services.secrets.list()).toEqual([]);
  });

  it('uses S256 PKCE, accepts the public callback, encrypts the key and applies Simple defaults', async () => {
    const attempt = await start();
    const url = new URL(attempt.url);
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
    expect(url.searchParams.get('callback_url')).toBe('http://localhost:9231/api/auth/openrouter/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('key_label')).toBe('NEO');
    expect(url.searchParams.get('state')).toBe(attempt.state);
    expect(attempt.expiresAt).toBe(now + 10 * 60_000);
    const response = await callback(attempt.state);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('NEO is connected to OpenRouter.');
    expect(html).toContain('You can close this tab.');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const exchange = calls.find(call => call.path.endsWith('/auth/keys'))!;
    expect(exchange.body).toMatchObject({ code: 'offline-code', code_challenge_method: 'S256' });
    const verifier = exchange.body['code_verifier'] as string;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(services.secrets.get('provider:openrouter')).toBe(KEY);
    expect(services.settings.get().ai).toMatchObject({ mode: 'simple', capabilities: { text: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5-5' }, embedding: null, speechToText: null, textToSpeech: null, image: null, video: null } });
    const stored = services.db!.prepare('SELECT config FROM provider_configs').get() as { config: string };
    expect(stored.config).not.toContain(KEY);
    const events = services.events.since(0);
    expect(events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: 'provider.connected', state: attempt.state, provider: expect.objectContaining({ id: 'openrouter', hasApiKey: true }) }) }));
    const responses = [html, await (await request('/api/providers')).text(), await (await request('/api/settings')).text(), JSON.stringify(events), JSON.stringify(logs), JSON.stringify(attempt)];
    for (const text of responses) expect(text).not.toMatch(/sk-or-offline-secret-never-returned|code_verifier|apiKeySecret/);
    expect(calls.filter(call => call.path.endsWith('/models')).every(call => call.authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it('rejects a bad state before any exchange', async () => {
    expect((await callback('unrecognized-state')).status).toBe(400);
    expect(calls).toEqual([]);
    expect(services.providerConfigs.list()).toEqual([]);
  });

  it('rejects replay of a used state and concurrent callbacks', async () => {
    const attempt = await start();
    const results = await Promise.all([callback(attempt.state), callback(attempt.state)]);
    expect(results.map(response => response.status).sort()).toEqual([200, 400]);
    expect((await callback(attempt.state)).status).toBe(400);
    expect(calls.filter(call => call.path.endsWith('/auth/keys'))).toHaveLength(1);
    expect(services.providerConfigs.list()).toHaveLength(1);
  });

  it('rejects an expired state at the ten-minute boundary', async () => {
    const attempt = await start();
    now = attempt.expiresAt;
    expect((await callback(attempt.state)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('handles upstream 403 without reflecting credentials and consumes the state', async () => {
    upstreamStatus = 403;
    const attempt = await start();
    const response = await callback(attempt.state);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ code: 'provider_auth', details: { status: 403 } });
    expect(text + JSON.stringify(logs)).not.toMatch(/sk-or-offline-secret-never-returned|code_verifier/);
    expect(services.providerConfigs.list()).toEqual([]);
    expect(services.secrets.list()).toEqual([]);
    expect((await callback(attempt.state)).status).toBe(400);
  });

  it('leaves no provider, key or settings behind when model discovery fails', async () => {
    modelsStatus = 403;
    const before = services.settings.get();
    const attempt = await start();
    const response = await callback(attempt.state);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(services.providerConfigs.list()).toEqual([]);
    expect(services.secrets.list()).toEqual([]);
    expect(services.settings.get()).toEqual(before);
  });

  it('requires owner access for start/cancel and invalidates cancelled attempts', async () => {
    const { token } = services.devices.create({ name: 'paired browser', platform: 'web' });
    expect((await request('/api/auth/openrouter/start', 'POST', undefined, null)).status).toBe(401);
    expect((await request('/api/auth/openrouter/start', 'POST', undefined, token)).status).toBe(403);
    const attempt = await start();
    expect((await request('/api/auth/openrouter/cancel', 'POST', { state: attempt.state }, token)).status).toBe(403);
    expect(await (await request('/api/auth/openrouter/cancel', 'POST', { state: attempt.state })).json()).toEqual({ cancelled: true });
    expect(await (await request('/api/auth/openrouter/cancel', 'POST', { state: attempt.state })).json()).toEqual({ cancelled: false });
    expect((await callback(attempt.state)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('connects a tested API key with Simple defaults and clears all assignments on disconnect', async () => {
    const response = await request('/api/providers', 'POST', { id: 'openrouter', kind: 'openai-compatible', label: 'OpenRouter', baseUrl, apiKey: KEY, simple: true });
    expect(response.status).toBe(201);
    const view = await response.json() as ProviderView;
    expect(view).toMatchObject({ id: 'openrouter', hasApiKey: true });
    expect(view).not.toHaveProperty('simple');
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(services.settings.get().ai.capabilities.text?.provider).toBe('openrouter');
    services.settings.update({ ai: { mode: 'advanced', capabilities: { speechToText: { provider: 'openrouter', model: 'voice-fixture' }, image: { provider: 'openrouter', model: 'image-fixture' } } } });
    expect((await request('/api/providers/openrouter', 'DELETE')).status).toBe(204);
    expect(Object.values(services.settings.get().ai.capabilities)).toEqual([null, null, null, null, null, null]);
    expect(services.secrets.get('provider:openrouter')).toBeUndefined();
  });

  it('rolls back secret and adapter when the provider write fails during Simple connection', async () => {
    const before = services.settings.get();
    vi.spyOn(services.providerConfigs, 'upsert').mockImplementationOnce(() => { throw new Error('Fixture persistence failure'); });
    const response = await request('/api/providers', 'POST', { id: 'openrouter', kind: 'openai-compatible', baseUrl, apiKey: KEY, simple: true });
    expect(response.status).toBe(500);
    expect(services.providerConfigs.list()).toEqual([]);
    expect(services.providers.get('openrouter')).toBeUndefined();
    expect(services.secrets.list()).toEqual([]);
    expect(services.settings.get()).toEqual(before);
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });
});
