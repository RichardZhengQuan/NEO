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
  for (const service of resources.splice(0)) await service.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('provider credential header security', () => {
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
