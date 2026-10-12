import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecretStore, openNeoDatabase, type NeoDatabase } from '@neo/storage';
import type { SecretStore } from '@neo/protocol';
import {
  CHATGPT_ISSUER, CHATGPT_RESOURCE, CHATGPT_SCOPES, chatGPTSecretName, createChatGPTAuthorization,
  createChatGPTTokenManager, exchangeChatGPTCode, parseIssuedClientId, readChatGPTCredentials,
  type ChatGPTAuthOptions, type ChatGPTCredentials, type ChatGPTTokenManager,
} from './chatgpt-auth.js';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CLIENT = 'oaiapp_local_test';
const NONCE = 'fresh-test-nonce';
const HOST = 'stable-test-host';
const REDIRECT = 'http://127.0.0.1:42123/callback';
const VERIFIER = 'a'.repeat(64);
const ACCESS = 'access-private-never-log';
const REFRESH = 'refresh-private-never-log';
let now: number;
let server: Server;
let options: ChatGPTAuthOptions;
let db: NeoDatabase;
let secrets: SecretStore;
let manager: ChatGPTTokenManager;
let calls: { path: string; body: Record<string, string>; headers: Record<string, string | string[] | undefined> }[];
let claims: Record<string, unknown>;
let signingKey: KeyObject;
let jwtHeader: Record<string, unknown>;
let tokenStatus: number;
let tokenError: unknown;
let tokenOverride: Record<string, unknown>;
let jwksStatus: number;
let gate: Promise<void> | undefined;
let release: (() => void) | undefined;

function jwt(overrides: Record<string, unknown> = {}): string {
  const parts = [jwtHeader, { ...claims, ...overrides }].map(value => Buffer.from(JSON.stringify(value)).toString('base64url'));
  const unsigned = parts.join('.');
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), signingKey).toString('base64url')}`;
}

beforeEach(async () => {
  now = 1_800_000_000_000;
  calls = [];
  claims = { iss: CHATGPT_ISSUER, aud: CLIENT, sub: 'account-subject', nonce: NONCE, exp: now / 1000 + 3600 };
  signingKey = pair.privateKey;
  jwtHeader = { alg: 'RS256', kid: 'local-rsa' };
  tokenStatus = jwksStatus = 200;
  tokenError = undefined;
  tokenOverride = {};
  gate = release = undefined;
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = Object.fromEntries(new URLSearchParams(raw));
    calls.push({ path: req.url!, body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/token') {
      await gate;
      res.statusCode = tokenStatus;
      const refreshing = body['grant_type'] === 'refresh_token';
      res.end(JSON.stringify(tokenStatus === 200 ? {
        access_token: refreshing ? `${ACCESS}-replacement` : ACCESS,
        refresh_token: refreshing ? `${REFRESH}-replacement` : REFRESH,
        id_token: jwt(), token_type: 'Bearer', scope: CHATGPT_SCOPES, expires_in: 3600,
        earliest_refresh_at: now / 1000, ...tokenOverride,
      } : { error: tokenError, private: `${ACCESS} ${REFRESH} ${jwt()}` }));
    } else if (req.url === '/jwks') {
      res.statusCode = jwksStatus;
      res.end(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'local-rsa', alg: 'RS256', use: 'sig' }] }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  options = { authorizationUrl: `${base}/authorize`, tokenUrl: `${base}/token`, jwksUrl: `${base}/jwks` };
  db = openNeoDatabase(':memory:');
  secrets = createSecretStore(db, new Uint8Array(32).fill(12));
  manager = createChatGPTTokenManager(secrets, options, () => now);
});

afterEach(async () => {
  release?.();
  await manager?.close();
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  db.close();
  vi.restoreAllMocks();
});

const exchange = () => exchangeChatGPTCode({ code: 'single-use-code', clientId: CLIENT, verifier: VERIFIER, redirectUri: REDIRECT, nonce: NONCE, hostId: HOST }, options, () => now);
async function stored(overrides: Partial<ChatGPTCredentials> = {}): Promise<ChatGPTCredentials> {
  const credentials = { ...await exchange(), ...overrides };
  secrets.set(chatGPTSecretName('chatgpt'), JSON.stringify(credentials));
  calls = [];
  return credentials;
}

describe('ChatGPT dynamic OAuth and ID tokens', () => {
  it('includes the exact scopes, resource, nonce, host identity and S256 challenge on first sign-in', () => {
    const url = new URL(createChatGPTAuthorization({ hostId: HOST, state: 'fresh-state', nonce: NONCE, verifier: VERIFIER, redirectUri: REDIRECT }));
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'dynamic_agent_client', response_type: 'code', scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1', ext_agent_host_id: HOST, agent_name_hint: 'NEO', state: 'fresh-state', nonce: NONCE,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'), redirect_uri: REDIRECT,
    });
  });

  it.each(['http://localhost:42123/callback', 'http://127.0.0.1:42123/api/callback', 'https://127.0.0.1:42123/callback', 'http://127.0.0.1:42123/callback?state=bad', 'http://127.0.0.1:42123/callback#fragment'])('rejects a non-protocol redirect URI: %s', redirectUri => {
    expect(() => createChatGPTAuthorization({ hostId: HOST, state: 'state', nonce: NONCE, verifier: VERIFIER, redirectUri })).toThrow('loopback callback');
  });

  it('reads only one valid issued callback client ID', () => {
    expect(parseIssuedClientId(new URLSearchParams({ client_id: CLIENT }))).toBe(CLIENT);
    for (const query of ['', 'client_id=dynamic_agent_client', 'client_id=oaiapp_', 'client_id=oaiapp_a&client_id=oaiapp_b', `client_id=${ACCESS}`]) {
      expect(() => parseIssuedClientId(new URLSearchParams(query))).toThrow('valid app identity');
    }
  });

  it('exchanges the issued client without a secret and stores its encrypted credentials', async () => {
    const credentials = await stored();
    expect(calls).toEqual([]);
    expect(credentials).toMatchObject({ clientId: CLIENT, sub: 'account-subject', hostId: HOST, scopes: CHATGPT_SCOPES.split(' '), accessToken: ACCESS, refreshToken: REFRESH, expiresAt: now + 3_600_000, earliestRefreshAt: now });
    expect(readChatGPTCredentials(secrets, 'chatgpt')).toEqual(credentials);
    const row = db.prepare('SELECT data FROM secrets WHERE name = ?').get(chatGPTSecretName('chatgpt')) as { data: Uint8Array };
    expect(Buffer.from(row.data).toString()).not.toContain(ACCESS);
    expect(Buffer.from(row.data).toString()).not.toContain(REFRESH);
    await exchange();
    const call = calls.find(call => call.path === '/token')!;
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call.headers['authorization']).toBeUndefined();
    expect(call.body).toEqual({ grant_type: 'authorization_code', client_id: CLIENT, code: 'single-use-code', code_verifier: VERIFIER, redirect_uri: REDIRECT, resource: CHATGPT_RESOURCE });
  });

  it('uses the persisted issued client and ID token hint on re-authorisation', async () => {
    const previous = await stored();
    const url = new URL(createChatGPTAuthorization({ hostId: HOST, state: 'new-state', nonce: 'new-nonce', verifier: VERIFIER, redirectUri: 'http://127.0.0.1:55222/callback', previous: readChatGPTCredentials(secrets, 'chatgpt') }));
    expect(url.searchParams.get('client_id')).toBe(CLIENT);
    expect(url.searchParams.get('id_token_hint')).toBe(previous.idToken);
    expect(url.searchParams.get('ext_agent_host_id')).toBe(HOST);
    expect(url.searchParams.has('agent_name_hint')).toBe(false);
  });

  it.each([
    ['wrong issuer', { iss: 'https://wrong.example' }],
    ['wrong audience', { aud: 'oaiapp_another' }],
    ['wrong nonce', { nonce: 'replayed-nonce' }],
    ['missing nonce', { nonce: undefined }],
    ['expired', { exp: 1_799_999_900 }],
    ['missing subject', { sub: undefined }],
  ])('rejects ID tokens with %s', async (_label, override) => {
    claims = { ...claims, ...override };
    await expect(exchange()).rejects.toMatchObject({ code: 'provider_auth', details: { reason: 'invalid_id_token' } });
    expect(secrets.list()).toEqual([]);
  });

  it('accepts an audience list containing the issued client', async () => {
    claims['aud'] = ['another-audience', CLIENT];
    expect((await exchange()).clientId).toBe(CLIENT);
  });

  it.each(['signature', 'algorithm', 'key-id', 'jwks'])('rejects a bad ID token %s', async kind => {
    if (kind === 'signature') signingKey = otherPair.privateKey;
    if (kind === 'algorithm') jwtHeader['alg'] = 'HS256';
    if (kind === 'key-id') jwtHeader['kid'] = 'untrusted-key';
    if (kind === 'jwks') jwksStatus = 503;
    await expect(exchange()).rejects.toMatchObject({ code: 'provider_auth', details: { reason: 'invalid_id_token' } });
  });

  it('requires a validated initial ID token and granted plan scopes', async () => {
    tokenOverride['id_token'] = undefined;
    await expect(exchange()).rejects.toMatchObject({ code: 'provider_auth' });
    tokenOverride = { scope: 'openid profile email offline_access' };
    await expect(exchange()).rejects.toThrow('did not grant access');
  });

  it('sanitizes upstream error strings and never logs credentials', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    tokenStatus = 403;
    tokenError = `${ACCESS} ${REFRESH}`;
    let failure: unknown;
    try { await exchange(); } catch (error) { failure = error; }
    expect(JSON.stringify(failure)).not.toContain(ACCESS);
    expect(JSON.stringify(failure)).not.toContain(REFRESH);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it.each([1_800_000_100, '1800000100', '2027-01-15T08:01:40.000Z', 1_800_000_100_000])('accepts absolute refresh timestamps: %s', async timestamp => {
    tokenOverride['earliest_refresh_at'] = timestamp;
    expect((await exchange()).earliestRefreshAt).toBe(1_800_000_100_000);
  });

  it('rejects malformed credential storage and token lifetimes without returning raw values', async () => {
    secrets.set(chatGPTSecretName('bad'), ACCESS);
    expect(readChatGPTCredentials(secrets, 'bad')).toBeUndefined();
    secrets.set(chatGPTSecretName('bad'), JSON.stringify({ clientId: CLIENT, accessToken: ACCESS }));
    expect(readChatGPTCredentials(secrets, 'bad')).toBeUndefined();
    tokenOverride = { expires_in: -1 };
    await expect(exchange()).rejects.toMatchObject({ code: 'provider_error' });
    tokenOverride = { earliest_refresh_at: ACCESS };
    await expect(exchange()).rejects.toMatchObject({ code: 'provider_error' });
  });
});

describe('ChatGPT rotating token manager', () => {
  it('returns a fresh token without refreshing', async () => {
    await stored();
    expect(await manager.accessToken('chatgpt')).toBe(ACCESS);
    expect(calls).toEqual([]);
  });

  it('serializes concurrent refreshes, persists rotation and uses the replacement next time', async () => {
    await stored({ expiresAt: now + 30_000 });
    gate = new Promise(resolve => { release = resolve; });
    const requests = Array.from({ length: 8 }, () => manager.accessToken('chatgpt'));
    await vi.waitFor(() => expect(calls.filter(call => call.path === '/token')).toHaveLength(1));
    release!();
    expect(await Promise.all(requests)).toEqual(Array(8).fill(`${ACCESS}-replacement`));
    expect(calls.find(call => call.path === '/token')?.body).toEqual({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: REFRESH, resource: CHATGPT_RESOURCE });
    expect(readChatGPTCredentials(secrets, 'chatgpt')?.refreshToken).toBe(`${REFRESH}-replacement`);
    now += 3_570_000;
    await manager.accessToken('chatgpt');
    expect(calls.filter(call => call.path === '/token')[1]?.body['refresh_token']).toBe(`${REFRESH}-replacement`);
  });

  it('waits for earliest_refresh_at and does not return an expired token', async () => {
    await stored({ expiresAt: now + 30_000, earliestRefreshAt: now + 45_000 });
    expect(await manager.accessToken('chatgpt')).toBe(ACCESS);
    expect(calls).toEqual([]);
    now += 31_000;
    await expect(manager.accessToken('chatgpt')).rejects.toMatchObject({ code: 'provider_error', details: { reason: 'subscription_sharing_usage_unavailable' } });
    expect(calls).toEqual([]);
    now += 14_000;
    expect(await manager.accessToken('chatgpt')).toBe(`${ACCESS}-replacement`);
  });

  it.each(['invalid_grant', 'subscription_sharing_invalid_user'])('marks %s disconnected and refuses later refresh attempts', async reason => {
    await stored({ expiresAt: now });
    tokenStatus = 401;
    tokenError = reason === 'invalid_grant' ? reason : { code: reason, message: ACCESS };
    await expect(manager.accessToken('chatgpt')).rejects.toMatchObject({ code: 'provider_auth', message: 'Disconnected; sign in again.', details: { reason } });
    expect(readChatGPTCredentials(secrets, 'chatgpt')?.needsReauthorization).toBe(true);
    await expect(manager.accessToken('chatgpt')).rejects.toThrow('Disconnected; sign in again.');
    expect(calls.filter(call => call.path === '/token')).toHaveLength(1);
  });

  it('rejects a refreshed ID token that changes account identity without rotating stored tokens', async () => {
    await stored({ expiresAt: now });
    claims['sub'] = 'another-account';
    await expect(manager.accessToken('chatgpt')).rejects.toMatchObject({ code: 'provider_auth', details: { reason: 'invalid_id_token' } });
    expect(readChatGPTCredentials(secrets, 'chatgpt')?.refreshToken).toBe(REFRESH);
  });

  it('preserves the previous validated ID token if a refresh does not replace it', async () => {
    const previous = await stored({ expiresAt: now });
    tokenOverride['id_token'] = undefined;
    await manager.accessToken('chatgpt');
    expect(readChatGPTCredentials(secrets, 'chatgpt')?.idToken).toBe(previous.idToken);
  });

  it('deletes disconnected credentials and blocks an in-flight refresh from restoring them', async () => {
    await stored({ expiresAt: now });
    gate = new Promise(resolve => { release = resolve; });
    const request = manager.accessToken('chatgpt').catch(error => error);
    await vi.waitFor(() => expect(calls.filter(call => call.path === '/token')).toHaveLength(1));
    manager.disconnect('chatgpt');
    release!();
    expect(await request).toMatchObject({ code: 'cancelled' });
    expect(readChatGPTCredentials(secrets, 'chatgpt')).toBeUndefined();
    await expect(manager.accessToken('chatgpt')).rejects.toThrow('Disconnected; sign in again.');
  });

  it('marks invalid-user model results as needing sign-in again', async () => {
    await stored();
    manager.markNeedsReauthorization('chatgpt');
    expect(readChatGPTCredentials(secrets, 'chatgpt')?.needsReauthorization).toBe(true);
    await expect(manager.accessToken('chatgpt')).rejects.toThrow('Disconnected; sign in again.');
    expect(calls).toEqual([]);
  });

  it('ignores an old model request failure after reconnect replaces the access token', async () => {
    await stored({ accessToken: 'new-sign-in-access-token', expiresAt: now });
    gate = new Promise(resolve => { release = resolve; });
    const refreshing = manager.accessToken('chatgpt');
    await vi.waitFor(() => expect(calls.filter(call => call.path === '/token')).toHaveLength(1));
    manager.markNeedsReauthorization('chatgpt', ACCESS);
    expect(readChatGPTCredentials(secrets, 'chatgpt')?.needsReauthorization).not.toBe(true);
    release!();
    expect(await refreshing).toBe(`${ACCESS}-replacement`);
    manager.markNeedsReauthorization('chatgpt', `${ACCESS}-replacement`);
    expect(readChatGPTCredentials(secrets, 'chatgpt')?.needsReauthorization).toBe(true);
  });

  it('invalidates an older refresh on sign-in even if the replacement credentials use the same tokens', async () => {
    const previous = await stored({ expiresAt: now });
    await manager.close();
    // A transport may finish despite cancellation; generation checks must still win.
    manager = createChatGPTTokenManager(secrets, { ...options, fetch: (url, init) => fetch(url, { ...init, signal: undefined }) }, () => now);
    gate = new Promise(resolve => { release = resolve; });
    const refreshing = manager.accessToken('chatgpt').catch(error => error);
    await vi.waitFor(() => expect(calls.filter(call => call.path === '/token')).toHaveLength(1));
    const replacement = { ...previous, expiresAt: now + 3_600_000, needsReauthorization: false };
    secrets.set(chatGPTSecretName('chatgpt'), JSON.stringify(replacement));
    manager.credentialsChanged('chatgpt');
    release!();
    expect(await refreshing).toMatchObject({ code: 'provider_auth' });
    expect(readChatGPTCredentials(secrets, 'chatgpt')).toEqual(replacement);
    expect(await manager.accessToken('chatgpt')).toBe(ACCESS);
  });

  it('closes pending refreshes without deleting saved credentials', async () => {
    await stored({ expiresAt: now });
    gate = new Promise(resolve => { release = resolve; });
    const request = manager.accessToken('chatgpt').catch(error => error);
    await vi.waitFor(() => expect(calls.filter(call => call.path === '/token')).toHaveLength(1));
    await manager.close();
    expect(await request).toMatchObject({ code: 'cancelled' });
    expect(readChatGPTCredentials(secrets, 'chatgpt')?.refreshToken).toBe(REFRESH);
    await expect(manager.accessToken('chatgpt')).rejects.toMatchObject({ code: 'cancelled' });
  });
});
