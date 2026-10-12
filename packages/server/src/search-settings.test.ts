import { afterEach, describe, expect, it } from 'vitest';
import { NeoConfigSchema, silentLogger } from '@neo/protocol';
import { createServices } from './services.js';
import { createApp } from './app.js';
import { resolveSearchEngine } from './search-settings.js';
import type { NeoServices } from './index.js';

let services: NeoServices;
afterEach(async () => { await services?.close(); });

async function fixture(config: unknown = {}) {
  services = await createServices(NeoConfigSchema.parse({ log: { level: 'silent' }, ...config as object }), { inMemory: true, logger: silentLogger });
  const { app } = createApp(services);
  return (path: string, method = 'GET', body?: unknown) => app.request(path, {
    method, headers: { Authorization: `Bearer ${services.ownerToken}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('search engine settings and secrets', () => {
  it('encrypts keys and redacts settings, provider lists and update events', async () => {
    const request = await fixture();
    const response = await request('/api/settings', 'PATCH', { ai: { search: { mode: 'engine', engine: { provider: 'brave', apiKey: 'private-search-key' } } } });
    expect(response.status).toBe(200);
    const returned = await response.text();
    expect(JSON.parse(returned).ai.search).toEqual({ mode: 'engine', engine: { provider: 'brave', hasApiKey: true } });
    expect(returned).not.toMatch(/private-search-key|apiKeySecret|search:engine/);
    expect(services.secrets.get('search:engine')).toBe('private-search-key');
    const settingsRow = services.db!.prepare('SELECT value FROM settings WHERE key = ?').get('settings') as { value: string };
    expect(settingsRow.value).not.toContain('private-search-key');
    const secretRow = services.db!.prepare('SELECT data FROM secrets WHERE name = ?').get('search:engine') as { data: Uint8Array };
    expect(Buffer.from(secretRow.data).toString()).not.toContain('private-search-key');
    for (const path of ['/api/settings', '/api/providers']) expect(await (await request(path)).text()).not.toMatch(/private-search-key|apiKeySecret|search:engine/);
    expect(JSON.stringify(services.events.since(0))).not.toMatch(/private-search-key|apiKeySecret|search:engine/);
    expect(resolveSearchEngine(services.settings.get(), services.config.webSearch, services.secrets)).toEqual({ provider: 'brave', apiKey: 'private-search-key' });
  });

  it('preserves omitted keys only for the same endpoint, and supports clearing', async () => {
    const request = await fixture();
    const patch = (engine: unknown) => request('/api/settings', 'PATCH', { ai: { search: { engine } } });
    await patch({ provider: 'brave', apiKey: 'old-key' });
    await patch({ provider: 'brave' });
    expect(services.secrets.get('search:engine')).toBe('old-key');
    await patch({ provider: 'tavily' });
    expect(services.secrets.get('search:engine')).toBeUndefined();
    await patch({ provider: 'tavily', apiKey: 'new-key' });
    await patch({ provider: 'tavily', apiKey: null });
    expect(services.secrets.get('search:engine')).toBeUndefined();
    await patch(null);
    expect(services.settings.get().ai.search.engine).toBeNull();
  });

  it('clears a previous provider URL and does not advertise keyless engines', async () => {
    const request = await fixture();
    await request('/api/settings', 'PATCH', { ai: { search: { engine: { provider: 'searxng', baseUrl: 'https://search.example' } } } });
    await request('/api/settings', 'PATCH', { ai: { search: { engine: { provider: 'brave' } } } });
    expect(services.settings.get().ai.search.engine?.baseUrl).toBeUndefined();
    expect(resolveSearchEngine(services.settings.get(), services.config.webSearch, services.secrets)).toBeUndefined();
    expect(resolveSearchEngine(services.settings.get(), { provider: 'brave' }, services.secrets)).toBeUndefined();
    expect(services.tools.get('web_search')).toBeUndefined();
  });

  it('rejects secret-reference injection and invalid patches before changing a key', async () => {
    const request = await fixture();
    services.secrets.set('provider:other', 'provider-credential');
    expect((await request('/api/settings', 'PATCH', { ai: { search: { engine: { provider: 'brave', apiKeySecret: 'provider:other' } } } })).status).toBe(400);
    expect((await request('/api/settings', 'PATCH', { ai: { search: { mode: 'invalid', engine: { provider: 'brave', apiKey: 'new-key' } } } })).status).toBe(400);
    expect(services.secrets.get('search:engine')).toBeUndefined();
    expect(services.secrets.get('provider:other')).toBe('provider-credential');
  });

  it('keeps boot config as the fallback and protects initial settings keys too', async () => {
    await fixture({ webSearch: { provider: 'searxng', baseUrl: 'http://127.0.0.1:8888' }, settings: { ai: { search: { mode: 'auto', engine: { provider: 'tavily', apiKey: 'initial-key' } } } } });
    expect(resolveSearchEngine(services.settings.get(), services.config.webSearch, services.secrets)).toEqual({ provider: 'tavily', apiKey: 'initial-key' });
    services.settings.update({ ai: { search: { engine: null } } });
    expect(resolveSearchEngine(services.settings.get(), services.config.webSearch, services.secrets)).toEqual({ provider: 'searxng', baseUrl: 'http://127.0.0.1:8888' });
  });
});
