import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoConfigSchema, type ChatGPTStartResponse, type Logger } from '@neo/protocol';
import { createApp } from './app.js';
import { createServices } from './services.js';
import { CHATGPT_ISSUER, CHATGPT_SCOPES, readChatGPTCredentials } from './chatgpt-auth.js';
import type { NeoServices } from './index.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ISSUED = 'oaiapp_offline_neo';
const ACCESS = 'offline-private-access-token';
const REFRESH = 'offline-private-refresh-token';
let fake: Server;
let services: NeoServices;
let app: ReturnType<typeof createApp>['app'];
let origin: string;
let now: number;
let nonce: string;
let idToken: string;
let calls: { path: string; body: URLSearchParams; authorization?: string }[];
let logs: unknown[];
let exchangeError: string | undefined;
let modelError: string | undefined;
let exchangeGate: Promise<void> | undefined;
let releaseExchange: (() => void) | undefined;

function jwt() {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'offline' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: CHATGPT_ISSUER, aud: ISSUED, sub: 'offline-subject', nonce, exp: now / 1000 + 3600 })).toString('base64url');
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}

beforeEach(async () => {
  now = 1_800_000_000_000;
  calls = []; logs = []; nonce = ''; idToken = '';
  exchangeError = modelError = undefined;
  exchangeGate = undefined; releaseExchange = undefined;
  fake = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = new URLSearchParams(raw);
    calls.push({ path: req.url!, body, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/token') {
      await exchangeGate;
      if (exchangeError) {
        res.statusCode = exchangeError === 'subscription_sharing_user_not_eligible' ? 403 : exchangeError === 'subscription_sharing_usage_limit_exceeded' ? 429 : 401;
        res.end(JSON.stringify({ error: { code: exchangeError, message: `${ACCESS} ${REFRESH} ${body.get('code_verifier')}` } }));
        return;
      }
      idToken = jwt();
      res.end(JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, id_token: idToken, token_type: 'Bearer', scope: CHATGPT_SCOPES, expires_in: 3600, earliest_refresh_at: now / 1000 + 60 }));
    } else if (req.url === '/jwks') {
      res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'offline', alg: 'RS256', use: 'sig' }] }));
    } else if (req.url === '/v1/models') {
      if (modelError) { res.statusCode = 403; res.end(JSON.stringify({ error: { code: modelError, message: ACCESS } })); return; }
      res.end(JSON.stringify({ data: [{ slug: 'gpt-5', visibility: 'list' }, { slug: 'gpt-6', visibility: 'list' }, { slug: 'private-model', visibility: 'hidden' }] }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  const record = (message: string, data?: Record<string, unknown>) => logs.push({ message, data });
  const logger: Logger = { debug: record, info: record, warn: record, error: record, child: () => logger };
  services = await createServices(NeoConfigSchema.parse({ mode: 'local', providers: [], plugins: { enabled: false }, log: { level: 'silent' } }), {
    inMemory: true, clock: () => now, logger,
    chatGPT: { authorizationUrl: `${origin}/authorize`, tokenUrl: `${origin}/token`, jwksUrl: `${origin}/jwks`, apiBaseUrl: `${origin}/v1` },
  });
  app = createApp(services).app;
});

afterEach(async () => {
  releaseExchange?.();
  await services?.close();
  await new Promise<void>(resolve => { fake.close(() => resolve()); fake.closeAllConnections(); });
});

function request(path: string, method = 'GET', body?: unknown, token: string | null = services.ownerToken) {
  return app.request(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function start(providerId?: string) {
  const response = await request('/api/auth/chatgpt/start', 'POST', providerId ? { providerId } : {});
  expect(response.status).toBe(200);
  return await response.json() as ChatGPTStartResponse;
}
async function authorize(attempt: ChatGPTStartResponse) {
  let url = new URL(attempt.url);
  if (url.pathname === '/callback') {
    const launch = await fetch(url, { redirect: 'manual' });
    expect(launch.status).toBe(302);
    url = new URL(launch.headers.get('location')!);
  }
  nonce = url.searchParams.get('nonce')!;
  return url;
}
async function callback(attempt: ChatGPTStartResponse, overrides: Record<string, string> = {}) {
  const url = await authorize(attempt);
  const callback = new URL(url.searchParams.get('redirect_uri')!);
  callback.search = new URLSearchParams({ state: attempt.state, code: 'offline-code', client_id: ISSUED, ...overrides }).toString();
  return fetch(callback);
}
const status = async (state: string) => (await request(`/api/auth/chatgpt/status?state=${state}`)).json();

describe('local ChatGPT sign-in', () => {
  it('starts the exact loopback listener before returning every required authorize parameter', async () => {
    const attempt = await start();
    const url = new URL(attempt.url);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: 'dynamic_agent_client', agent_name_hint: 'NEO', scope: CHATGPT_SCOPES, resource: 'https://api.openai.com/v1', state: attempt.state, code_challenge_method: 'S256' });
    expect(url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('ext_agent_host_id')).toBe(services.secrets.get('chatgpt:host-id'));
    const redirect = url.searchParams.get('redirect_uri')!;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect((await fetch(redirect.replace('/callback', '/other'))).status).toBe(404);
    expect((await fetch(redirect, { method: 'POST' })).status).toBe(404);
    expect(attempt.expiresAt).toBe(now + 600_000);
    const response = await callback(attempt);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Connected, you can close this tab');
    const exchange = calls.find(call => call.path === '/token')!;
    expect(exchange.body.get('client_id')).toBe(ISSUED);
    expect(exchange.body.get('grant_type')).toBe('authorization_code');
    expect(exchange.body.get('resource')).toBe('https://api.openai.com/v1');
    expect(exchange.body.get('redirect_uri')).toBe(redirect);
    expect(exchange.body.has('client_secret')).toBe(false);
    expect(createHash('sha256').update(exchange.body.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(services.settings.get().ai.capabilities).toEqual({ text: { provider: 'chatgpt', model: 'gpt-6' }, embedding: null, speechToText: null, textToSpeech: null, image: null, video: null });
    expect(await status(attempt.state)).toMatchObject({ status: 'connected', provider: { id: 'chatgpt', kind: 'chatgpt', needsReauthorization: false } });
  });

  it('persists the issued registration and reuses it with an ID-token hint without API token leakage', async () => {
    const first = await start();
    expect((await callback(first)).status).toBe(200);
    const firstToken = idToken;
    const credentials = readChatGPTCredentials(services.secrets, 'chatgpt')!;
    expect(credentials).toMatchObject({ clientId: ISSUED, sub: 'offline-subject', accessToken: ACCESS, refreshToken: REFRESH, hostId: services.secrets.get('chatgpt:host-id') });
    const second = await start('chatgpt');
    expect(JSON.stringify(second)).not.toContain(firstToken);
    const url = await authorize(second);
    expect(url.searchParams.get('client_id')).toBe(ISSUED);
    expect(url.searchParams.has('agent_name_hint')).toBe(false);
    expect(url.searchParams.get('id_token_hint')).toBe(firstToken);
    expect(url.searchParams.get('ext_agent_host_id')).toBe(credentials.hostId);
    const redirect = new URL(url.searchParams.get('redirect_uri')!);
    redirect.search = new URLSearchParams({ state: second.state, code: 'next-code', client_id: ISSUED }).toString();
    expect((await fetch(redirect)).status).toBe(200);
    expect(services.providerConfigs.list()).toHaveLength(1);
    const exposed = [await (await request('/api/providers')).text(), await (await request('/api/settings')).text(), JSON.stringify(await status(second.state)), JSON.stringify(services.events.since(0)), JSON.stringify(logs)];
    for (const value of exposed) for (const token of [ACCESS, REFRESH, idToken, firstToken]) expect(value).not.toContain(token);
    const stored = services.db!.prepare('SELECT config FROM provider_configs').get() as { config: string };
    expect(stored.config).not.toContain(ISSUED);
    const encrypted = services.db!.prepare('SELECT data FROM secrets WHERE name = ?').get('provider:chatgpt:chatgpt') as { data: Uint8Array };
    expect(Buffer.from(encrypted.data).toString()).not.toContain(ACCESS);
  });

  it('rejects a mismatched state without exchange and allows the correct callback once', async () => {
    const attempt = await start();
    expect((await callback(attempt, { state: 'mismatch' })).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await callback(attempt)).status).toBe(200);
  });

  it('consumes state before awaiting exchange so concurrent replay fails', async () => {
    const attempt = await start();
    exchangeGate = new Promise(resolve => { releaseExchange = resolve; });
    const first = callback(attempt);
    await vi.waitFor(() => expect(calls.some(call => call.path === '/token')).toBe(true));
    expect((await callback(attempt)).status).toBe(400);
    releaseExchange!();
    expect((await first).status).toBe(200);
    expect(calls.filter(call => call.path === '/token')).toHaveLength(1);
  });

  it('rejects malformed callback URLs without terminating the listener', async () => {
    const attempt = await start();
    const redirect = new URL(new URL(attempt.url).searchParams.get('redirect_uri')!);
    const malformedStatus = await new Promise<number>(resolve => {
      const req = httpRequest({ hostname: '127.0.0.1', port: redirect.port, path: 'http://[::/callback' }, res => { res.resume(); resolve(res.statusCode!); });
      req.end();
    });
    expect(malformedStatus).toBe(400);
    expect((await callback(attempt)).status).toBe(200);
  });

  it('does not revive a deleted connection when its pending reconnect finishes', async () => {
    expect((await callback(await start())).status).toBe(200);
    const attempt = await start('chatgpt');
    exchangeGate = new Promise(resolve => { releaseExchange = resolve; });
    const completing = callback(attempt);
    await vi.waitFor(() => expect(calls.filter(call => call.path === '/token')).toHaveLength(2));
    expect((await request('/api/providers/chatgpt', 'DELETE')).status).toBe(204);
    expect((await completing).status).toBe(499);
    releaseExchange!();
    expect(await status(attempt.state)).toEqual({ status: 'cancelled' });
    expect(services.providerConfigs.list()).toEqual([]);
    expect(readChatGPTCredentials(services.secrets, 'chatgpt')).toBeUndefined();
  });

  it('preserves registration and installation identity across server restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'neo-chatgpt-restart-'));
    const options = { chatGPT: services.chatGPT, logger: services.logger, clock: () => now };
    const config = NeoConfigSchema.parse({ dataDir, mode: 'local', plugins: { enabled: false }, log: { level: 'silent' } });
    try {
      await services.close();
      services = await createServices(config, options);
      app = createApp(services).app;
      expect((await callback(await start())).status).toBe(200);
      const before = readChatGPTCredentials(services.secrets, 'chatgpt')!;
      await services.close();
      services = await createServices(config, options);
      app = createApp(services).app;
      expect(readChatGPTCredentials(services.secrets, 'chatgpt')).toEqual(before);
      const reauthorize = await authorize(await start('chatgpt'));
      expect(reauthorize.searchParams.get('client_id')).toBe(ISSUED);
      expect(reauthorize.searchParams.get('ext_agent_host_id')).toBe(before.hostId);
      expect(reauthorize.searchParams.get('id_token_hint')).toBe(before.idToken);
      expect(reauthorize.searchParams.has('agent_name_hint')).toBe(false);
      expect(await services.chatGPTTokens!.accessToken('chatgpt')).toBe(ACCESS);
    } finally {
      await services.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('expires at ten minutes and does not exchange an expired code', async () => {
    const attempt = await start();
    now = attempt.expiresAt;
    expect((await callback(attempt)).status).toBe(400);
    expect(await status(attempt.state)).toMatchObject({ status: 'failed', error: { code: 'timeout' } });
    expect(calls).toEqual([]);
  });

  it('closes its listener automatically on timeout without a callback', async () => {
    services.chatGPT!.timeoutMs = 20;
    const attempt = await start();
    await vi.waitFor(async () => expect(await status(attempt.state)).toMatchObject({ status: 'failed', error: { code: 'timeout' } }));
    await expect(fetch(new URL(attempt.url).searchParams.get('redirect_uri')!)).rejects.toThrow();
  });

  it('cancels a pending listener and an in-flight exchange without storing tokens', async () => {
    const attempt = await start();
    exchangeGate = new Promise(resolve => { releaseExchange = resolve; });
    const completing = callback(attempt);
    await vi.waitFor(() => expect(calls.some(call => call.path === '/token')).toBe(true));
    expect(await (await request('/api/auth/chatgpt/cancel', 'POST', { state: attempt.state })).json()).toEqual({ cancelled: true });
    expect((await completing).status).toBe(499);
    expect(await status(attempt.state)).toEqual({ status: 'cancelled' });
    releaseExchange!();
    expect(services.providerConfigs.list()).toEqual([]);
    expect(services.secrets.list()).toEqual(['chatgpt:host-id']);
  });

  it.each(['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable', 'subscription_sharing_user_not_eligible', 'subscription_sharing_invalid_user'])('exposes safe typed guidance for callback error %s', async reason => {
    exchangeError = reason;
    const attempt = await start();
    expect((await callback(attempt)).status).toBeGreaterThanOrEqual(400);
    expect(await status(attempt.state)).toMatchObject({ status: 'failed', error: { details: { reason } } });
    const value = JSON.stringify(await status(attempt.state)) + JSON.stringify(logs);
    expect(value).not.toContain(ACCESS);
    expect(value).not.toContain(REFRESH);
  });

  it('does not persist credentials when discovery fails or saving fails', async () => {
    modelError = 'subscription_sharing_user_not_eligible';
    const before = services.settings.get();
    const failed = await start();
    expect((await callback(failed)).status).toBeGreaterThanOrEqual(400);
    expect(services.secrets.list()).toEqual(['chatgpt:host-id']);
    modelError = undefined;
    vi.spyOn(services.providerConfigs, 'upsert').mockImplementationOnce(() => { throw new Error(ACCESS); });
    const attempt = await start();
    expect((await callback(attempt)).status).toBe(502);
    expect(services.providerConfigs.list()).toEqual([]);
    expect(services.providers.get('chatgpt')).toBeUndefined();
    expect(services.settings.get()).toEqual(before);
    expect(JSON.stringify(logs)).not.toContain(ACCESS);
  });

  it('keeps Advanced assignments and rejects unsupported capability assignments', async () => {
    services.settings.update({ ai: { mode: 'advanced' } });
    const attempt = await start();
    expect((await callback(attempt)).status).toBe(200);
    expect(services.settings.get().ai.capabilities.text).toBeNull();
    expect((await request('/api/settings', 'PATCH', { ai: { capabilities: { image: { provider: 'chatgpt', model: 'gpt-6' } } } })).status).toBe(400);
    expect((await request('/api/settings', 'PATCH', { ai: { capabilities: { text: { provider: 'chatgpt', model: 'gpt-6' } } } })).status).toBe(200);
  });

  it('marks expired sessions as needing sign-in and disconnect removes credentials while retaining host identity', async () => {
    const attempt = await start();
    expect((await callback(attempt)).status).toBe(200);
    services.chatGPTTokens!.markNeedsReauthorization('chatgpt');
    const views = await (await request('/api/providers')).json() as { items: { needsReauthorization: boolean }[] };
    expect(views.items[0]!.needsReauthorization).toBe(true);
    expect((await request('/api/providers/chatgpt', 'DELETE')).status).toBe(204);
    expect(readChatGPTCredentials(services.secrets, 'chatgpt')).toBeUndefined();
    expect(services.secrets.list()).toEqual(['chatgpt:host-id']);
    expect(services.settings.get().ai.capabilities.text).toBeNull();
  });

  it('marks a reconnecting account as needing sign-in when ChatGPT rejects its user', async () => {
    expect((await callback(await start())).status).toBe(200);
    exchangeError = 'subscription_sharing_invalid_user';
    const attempt = await start('chatgpt');
    expect((await callback(attempt)).status).toBe(502);
    expect(readChatGPTCredentials(services.secrets, 'chatgpt')?.needsReauthorization).toBe(true);
    expect(await status(attempt.state)).toMatchObject({ status: 'failed', error: { details: { reason: exchangeError } } });
  });

  it('requires owner for start/status/cancel and forbids server mode before binding', async () => {
    const { token } = services.devices.create({ name: 'paired device', platform: 'web' });
    for (const [path, method, body] of [['/api/auth/chatgpt/start', 'POST', {}], ['/api/auth/chatgpt/status?state=none', 'GET', undefined], ['/api/auth/chatgpt/cancel', 'POST', { state: 'none' }]] as const) {
      expect((await request(path, method, body, null)).status).toBe(401);
      expect((await request(path, method, body, token)).status).toBe(403);
    }
    services.config.mode = 'server';
    const response = await request('/api/auth/chatgpt/start', 'POST', {});
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('Available when NEO runs on this computer');
    expect(services.secrets.list()).toEqual([]);
  });

  it('prevents API credentials or endpoint edits from replacing account authentication', async () => {
    expect((await request('/api/providers', 'POST', { kind: 'chatgpt', apiKey: ACCESS })).status).toBe(400);
    expect((await request('/api/providers/test', 'POST', { kind: 'chatgpt', apiKey: ACCESS })).status).toBe(400);
    const attempt = await start();
    expect((await callback(attempt)).status).toBe(200);
    expect((await request('/api/providers/chatgpt', 'PATCH', { baseUrl: `${origin}/evil` })).status).toBe(400);
    expect((await request('/api/providers/chatgpt', 'PATCH', { apiKey: ACCESS })).status).toBe(400);
    expect((await request('/api/providers/chatgpt', 'PATCH', { label: 'My ChatGPT', enabled: false })).status).toBe(200);
  });
});
