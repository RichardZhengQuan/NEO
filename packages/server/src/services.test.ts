import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoConfigSchema, silentLogger } from '@neo/protocol';
import type { Message, ServerEvent } from '@neo/protocol';
import { createServices, environmentLocale } from './services.js';
import { createApp } from './app.js';
import type { NeoServices } from './index.js';

const resources: NeoServices[] = [];
const directories: string[] = [];
const clock = () => 1_800_000_000_000;
function temp(): string {
  const directory = mkdtempSync(join(tmpdir(), 'neo-server-services-'));
  directories.push(directory);
  return directory;
}
async function services(raw: unknown = {}, inMemory = true, mockScript?: import('@neo/providers').MockScript) {
  const result = await createServices(NeoConfigSchema.parse({ dataDir: join(temp(), 'data'), log: { level: 'silent' }, ...raw as object }), {
    inMemory, clock, logger: silentLogger, ...(mockScript ? { mockScript } : {}),
  });
  resources.push(result);
  return result;
}
function exchange(text: string): { conversationId: string; userMessage: Message; assistantMessage: Message } {
  return {
    conversationId: 'conv_test',
    userMessage: { id: 'msg_user', conversationId: 'conv_test', role: 'user', parts: [{ type: 'text', text }], createdAt: clock(), status: 'complete' },
    assistantMessage: { id: 'msg_reply', conversationId: 'conv_test', role: 'assistant', parts: [{ type: 'text', text: 'Thanks for telling me.' }], createdAt: clock(), status: 'complete' },
  };
}
afterEach(async () => {
  for (const service of resources.splice(0)) await service.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function liveEmbeddingFixture(raw: unknown = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const input = JSON.parse(String(init?.body)) as { input: string[] };
    return Response.json({ data: input.input.map((_text, index) => ({ index, embedding: [1, 0, 0] })) });
  });
  vi.stubGlobal('fetch', fetch);
  const s = await services({ providers: [], plugins: { enabled: false }, ...raw as object });
  const { app } = createApp(s);
  const request = (path: string, method: string, body?: unknown) => app.request(path, {
    method, headers: { Authorization: `Bearer ${s.ownerToken}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const addProvider = () => request('/api/providers', 'POST', {
    id: 'remote', kind: 'openai', baseUrl: 'https://embeddings.example/v1', apiKey: 'embedding-fixture-key',
  });
  return { s, fetch, request, addProvider };
}

describe('server composition', () => {
  it('stops real remote embedding requests after the settings route selects offline embeddings', async () => {
    const live = await liveEmbeddingFixture({
      providers: [{ id: 'remote', kind: 'openai', baseUrl: 'https://embeddings.example/v1', apiKey: 'embedding-fixture-key' }],
      settings: { embedding: { provider: 'remote', model: 'text-embedding-fixture' } },
    });
    await live.s.memory.remember({ content: 'Remote embedding before the switch' });
    expect(live.fetch).toHaveBeenCalled();
    expect(live.fetch.mock.calls.every(([url]) => String(url) === 'https://embeddings.example/v1/embeddings')).toBe(true);
    expect((await live.s.memory.stats()).embeddingModel).toBe('remote:text-embedding-fixture');
    expect((await live.request('/api/settings', 'PATCH', { embedding: null })).status).toBe(200);
    live.fetch.mockClear();
    const node = await live.s.memory.remember({ content: 'Offline embedding after the switch' });
    expect(live.fetch).not.toHaveBeenCalled();
    expect((await live.s.memory.stats()).embeddingModel).toBe('hash2-512');
    expect(live.s.db?.prepare('SELECT model FROM memory_vectors WHERE node_id = ?').get(node.id)).toEqual({ model: 'hash2-512' });
  });

  it('refreshes a selected embedding provider when it is created, disabled, and enabled through routes', async () => {
    const live = await liveEmbeddingFixture({ settings: { embedding: { provider: 'remote', model: 'text-embedding-fixture' } } });
    expect((await live.s.memory.stats()).embeddingModel).toBe('hash2-512');
    expect((await live.addProvider()).status).toBe(201);
    expect((await live.s.memory.stats()).embeddingModel).toBe('remote:text-embedding-fixture');
    await live.s.memory.remember({ content: 'Enabled provider embeds this' });
    expect(live.fetch).toHaveBeenCalled();
    expect((await live.request('/api/providers/remote', 'PATCH', { enabled: false })).status).toBe(200);
    live.fetch.mockClear();
    await live.s.memory.remember({ content: 'Disabled provider keeps this offline' });
    expect(live.fetch).not.toHaveBeenCalled();
    expect((await live.s.memory.stats()).embeddingModel).toBe('hash2-512');
    expect((await live.request('/api/providers/remote', 'PATCH', { enabled: true })).status).toBe(200);
    await live.s.memory.remember({ content: 'Re-enabled provider embeds this' });
    expect(live.fetch).toHaveBeenCalled();
    expect((await live.s.memory.stats()).embeddingModel).toBe('remote:text-embedding-fixture');
  });

  it('refreshes live embedding credentials and URL after provider changes while unrelated changes leave it alone', async () => {
    const live = await liveEmbeddingFixture();
    expect((await live.addProvider()).status).toBe(201);
    expect((await live.request('/api/settings', 'PATCH', { embedding: { provider: 'remote', model: 'text-embedding-fixture' } })).status).toBe(200);
    await live.s.memory.remember({ content: 'First credential request' });
    expect(new Headers(live.fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer embedding-fixture-key');
    expect((await live.request('/api/providers/remote', 'PATCH', { apiKey: 'replacement-embedding-key', headers: { 'x-api-key': 'first-header-key' } })).status).toBe(200);
    live.fetch.mockClear();
    await live.s.memory.remember({ content: 'Replacement API and header credential request' });
    expect(live.fetch.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of live.fetch.mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer replacement-embedding-key');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('first-header-key');
    }
    expect((await live.request('/api/providers/remote', 'PATCH', { baseUrl: 'https://replacement.example/v1', headers: { 'x-api-key': 'replacement-header-key' } })).status).toBe(200);
    live.fetch.mockClear();
    await live.s.memory.remember({ content: 'Replacement host and header request' });
    for (const [url, init] of live.fetch.mock.calls) {
      expect(String(url)).toBe('https://replacement.example/v1/embeddings');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('replacement-header-key');
    }
    const swap = vi.spyOn(live.s.memory as import('@neo/protocol').MemoryService & { setEmbedder: (embedder: import('@neo/protocol').Embedder) => void }, 'setEmbedder');
    expect((await live.request('/api/providers', 'POST', { id: 'unrelated', kind: 'mock' })).status).toBe(201);
    expect((await live.request('/api/providers/unrelated', 'PATCH', { label: 'renamed' })).status).toBe(200);
    expect(swap).not.toHaveBeenCalled();
  });

  it('falls back immediately after deleting the embedding provider and recovers when that provider is recreated', async () => {
    const live = await liveEmbeddingFixture();
    expect((await live.addProvider()).status).toBe(201);
    expect((await live.request('/api/settings', 'PATCH', { embedding: { provider: 'remote', model: 'text-embedding-fixture' } })).status).toBe(200);
    await live.s.memory.remember({ content: 'Before provider deletion' });
    expect((await live.request('/api/providers/remote', 'DELETE')).status).toBe(204);
    live.fetch.mockClear();
    await live.s.memory.remember({ content: 'After provider deletion' });
    expect(live.fetch).not.toHaveBeenCalled();
    expect((await live.s.memory.stats()).embeddingModel).toBe('hash2-512');
    expect((await live.addProvider()).status).toBe(201);
    await live.s.memory.remember({ content: 'After provider recreation' });
    expect(live.fetch).toHaveBeenCalled();
    expect((await live.s.memory.stats()).embeddingModel).toBe('remote:text-embedding-fixture');
  });

  // WP-providers regression: isLocalUrl(undefined) is false, so the stock
  // MockProvider's `?? true` fallback never marks its offline endpoint local.
  it('stock offline mock is treated as local for sensitive-memory policy', async () => {
    const s = await services();
    expect(s.providers.get('demo')?.isLocal).toBe(true);
  });

  it('keeps the entire in-memory instance off disk and creates an owner and ephemeral push keys', async () => {
    const s = await services();
    expect(existsSync(s.config.dataDir)).toBe(false);
    expect(s.db?.path).toBe(':memory:');
    expect(s.devices.verify(s.ownerToken)?.owner).toBe(true);
    expect(s.config.push.vapidPublicKey).toBeTruthy();
    expect(s.tools.info().find(tool => tool.name === 'create_reminder')?.source).toBe('builtin');
    await s.close();
    await s.close();
    expect(s.db?.raw.isOpen).toBe(false);
  });

  it('detects host defaults, merges initial settings, and never re-applies them on restart', async () => {
    vi.stubEnv('LC_ALL', 'zh_CN.UTF-8');
    const dataDir = join(temp(), 'private');
    const s = await services({ dataDir, settings: { persona: { name: 'Nova' }, memory: { recallLimit: 5 } } }, false);
    expect(s.settings.get().timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(s.settings.get().locale).toBe('zh-CN');
    expect(s.settings.get().persona).toMatchObject({ name: 'Nova', tone: 'warm' });
    expect(s.settings.get().memory.recallLimit).toBe(5);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, 'token')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, 'key')).mode & 0o777).toBe(0o600);
    s.settings.update({ persona: { name: 'Persisted' }, timezone: 'Europe/Berlin', locale: 'de-DE' });
    await s.close();
    const again = await services({ dataDir, settings: { persona: { name: 'Overwrite' } } }, false);
    expect(again.settings.get()).toMatchObject({ timezone: 'Europe/Berlin', locale: 'de-DE', onboarded: false, persona: { name: 'Persisted' } });
    expect(again.ownerToken).toBe(s.ownerToken);
  });

  it('uses config token ahead of disk and registers a changed owner token', async () => {
    const dataDir = join(temp(), 'data');
    const first = await services({ dataDir }, false);
    const diskToken = readFileSync(join(dataDir, 'token'), 'utf8');
    await first.close();
    const changed = await services({ dataDir, server: { authToken: 'a-new-owner-token-0123456789' } }, false);
    expect(changed.ownerToken).toBe('a-new-owner-token-0123456789');
    expect(changed.devices.verify(changed.ownerToken)?.owner).toBe(true);
    expect(readFileSync(join(dataDir, 'token'), 'utf8')).toBe(diskToken);
  });

  it('immediately propagates settings policy/permissions and forwards each change once', async () => {
    const s = await services();
    const events: ServerEvent[] = [];
    s.events.subscribe(envelope => {
      expect(envelope.at).toBe(clock());
      events.push(envelope.event);
    });
    s.settings.update({ memory: { mode: 'approve' }, tools: { permissions: { calculate: 'deny', delete_task: 'auto' } } });
    expect(s.memory.getPolicy().mode).toBe('approve');
    expect(s.tools.permissionFor('calculate')).toBe('deny');
    expect(s.tools.permissionFor('delete_task')).toBe('auto');
    await s.memory.remember({ content: 'Richard enjoys hiking', source: { by: 'user' } });
    const reminder = s.stores.reminders.create({ title: 'Water', dueAt: clock() + 10_000 });
    s.stores.reminders.delete(reminder.id);
    const task = s.stores.tasks.create({ title: 'Plan a hike' });
    s.stores.tasks.delete(task.id);
    const note = s.stores.notes.create({ content: 'A route' });
    s.stores.notes.delete(note.id);
    expect(events.map(e => e.type)).toEqual(['settings.updated', 'memory.changed', 'reminder.updated', 'reminder.deleted', 'task.updated', 'task.deleted', 'note.updated', 'note.deleted']);
  });

  it('creates the specified reminder notification including missed and empty-note fallbacks', async () => {
    const s = await services();
    const fire = (title: string, notes: string | null, lateness: number) => {
      const r = s.stores.reminders.create({ title, notes, dueAt: clock() - lateness });
      s.scheduler.tick(clock());
      return s.stores.notifications.list().find(n => n.data?.['reminderId'] === r.id)!;
    };
    expect(fire('Water', null, 0)).toMatchObject({ kind: 'reminder', title: 'Water', body: "It's time" });
    expect(fire('Stretch', 'Stand up', 0).body).toBe('Stand up');
    expect(fire('Medicine', 'Daily', 1_000_000)).toMatchObject({ title: 'Medicine', body: 'Missed while you were away: Medicine' });
    expect(s.stores.notifications.list().every(n => n.data?.['url'] === `neo://reminders/${n.data?.['reminderId']}`)).toBe(true);
    expect(s.events.since(0).filter(e => e.event.type === 'reminder.fired')).toHaveLength(3);
  });

  it('falls back to the built-in embedder when the configured embedding provider is disabled', async () => {
    // A disabled provider must not be activated for embedding (the enabled check must happen
    // before providers.resolve() so it throws for disabled providers).
    const s = await services({
      providers: [{ id: 'embed-provider', kind: 'mock', enabled: false, defaultModel: 'model' }],
      settings: { embedding: { provider: 'embed-provider', model: 'text-embedding' } },
    });
    // providers.get() would return the adapter; providers.resolve() throws for disabled.
    expect(s.providers.get('embed-provider')).toBeDefined();
    expect(() => s.providers.resolve({ provider: 'embed-provider', model: 'any' })).toThrow();
    // The disabled provider must not have been used for embedding.
    expect((await s.memory.stats()).embeddingModel).toBe('hash2-512');
    const node = await s.memory.remember({ content: 'Disabled provider must not embed this', source: { by: 'user' } });
    expect(s.db?.prepare('SELECT model FROM memory_vectors WHERE node_id = ?').get(node.id)).toEqual({ model: 'hash2-512' });
  });

  it('live-swaps the embedder when the embedding setting changes', async () => {
    // A saved (here unusable) embedding choice, so switching to null is a real change of setting.
    const s = await services({ settings: { embedding: { provider: 'deleted-provider', model: 'test-embedding' } } });
    expect((await s.memory.stats()).embeddingModel).toBe('hash2-512');

    // Inject a custom non-local embedder directly to simulate a cloud embedder being active.
    const embeds: string[][] = [];
    const fakeEmbedder: import('@neo/protocol').Embedder = {
      id: 'fake-cloud-embed', dimensions: 512,
      embed: async (texts) => { embeds.push(texts); return texts.map(() => new Float32Array(512)); },
    };
    (s.memory as { setEmbedder?: (e: typeof fakeEmbedder) => void }).setEmbedder?.(fakeEmbedder);
    expect((await s.memory.stats()).embeddingModel).toBe('fake-cloud-embed');

    // Unrelated settings changes leave the active embedder alone.
    s.settings.update({ timezone: 'Europe/Paris' });
    expect((await s.memory.stats()).embeddingModel).toBe('fake-cloud-embed');

    // Patching embedding to null must live-swap back to the built-in offline embedder.
    s.settings.update({ embedding: null });
    expect((await s.memory.stats()).embeddingModel).toBe('hash2-512');

    // The fake embedder must not be called after the swap.
    const countBefore = embeds.length;
    await s.memory.remember({ content: 'No cloud call expected after null swap', source: { by: 'user' } });
    expect(embeds.length).toBe(countBefore);
    expect((await s.memory.stats()).embeddingModel).toBe('hash2-512');
  });

  it('falls back to the offline embedder when the configured embedding provider cannot embed', async () => {
    // The offline mock has no embeddings endpoint; a missing provider behaves the same way.
    for (const provider of ['demo', 'deleted-provider']) {
      const s = await services({ settings: { embedding: { provider, model: 'test-embedding' } } });
      expect((await s.memory.stats()).embeddingModel).toBe('hash2-512');
      const node = await s.memory.remember({ content: 'Embedded hiking preference', source: { by: 'user' } });
      expect(s.db?.prepare('SELECT model FROM memory_vectors WHERE node_id = ?').get(node.id)).toEqual({ model: 'hash2-512' });
    }
  });

  it('resolves memory LLM dynamically and falls back without throwing for missing/disabled models', async () => {
    const requests: string[] = [];
    const script: import('@neo/providers').MockScript = request => {
      requests.push(request.model);
      return { text: JSON.stringify({ episode: null, memories: [{ op: 'create', kind: 'preference', label: 'Hiking', content: 'Richard loves hiking', importance: 0.8 }], links: [] }) };
    };
    const s = await services({ providers: [
      { id: 'disabled', kind: 'mock', enabled: false, defaultModel: 'disabled-model' },
      { id: 'demo', kind: 'mock', enabled: true, defaultModel: 'fallback-model' },
    ] }, true, script);
    await s.memory.observe(exchange('My name is Richard and I love hiking'));
    expect(requests).toEqual(['fallback-model']);
    s.settings.update({ defaultModel: { provider: 'demo', model: 'default-model' } });
    await s.memory.observe(exchange('I love hiking in the mountains'));
    s.settings.update({ memoryModel: { provider: 'demo', model: 'memory-model' } });
    await s.memory.observe(exchange('I love hiking with friends'));
    expect(requests).toEqual(['fallback-model', 'default-model', 'memory-model']);
    s.settings.update({ memoryModel: { provider: 'missing', model: 'missing-model' } });
    const write = await s.memory.observe(exchange('I like skating'));
    expect(requests).toHaveLength(3);
    expect(write.created.length + write.updated.length).toBeGreaterThan(0);
  });

  it('loads enabled plugins using plugin source', async () => {
    const dataDir = join(temp(), 'data');
    const plugins = join(dataDir, 'plugins');
    mkdirSync(plugins, { recursive: true });
    writeFileSync(join(plugins, 'test.mjs'), `export default { name: 'test', tools: [{ name: 'plugin_read', title: 'Plugin', description: 'Fixture', inputSchema: { safeParse: (input) => ({ success: true, data: input }) }, risk: 'read', defaultPermission: 'auto', execute: async () => ({ output: 'ok' }) }] };`);
    const s = await services({ dataDir, plugins: { enabled: true } });
    expect(s.tools.info().find(tool => tool.name === 'plugin_read')).toMatchObject({ source: 'plugin', permission: 'auto' });
    expect(existsSync(join(dataDir, 'token'))).toBe(false);
  });
});

describe('locale detection', () => {
  it.each([
    [{ LANG: 'en_US.UTF-8' }, 'en-US'], [{ LANG: 'de_DE@euro' }, 'de-DE'],
    [{ LANG: 'en_US.UTF-8', LC_ALL: 'zh_CN.UTF-8' }, 'zh-CN'],
    [{ LANG: 'C.UTF-8' }, 'en'], [{ LANG: 'POSIX' }, 'en'], [{ LANG: 'invalid_locale!' }, 'en'], [{}, 'en'],
  ])('canonicalizes %j', (env, expected) => { expect(environmentLocale(env)).toBe(expected); });
});
