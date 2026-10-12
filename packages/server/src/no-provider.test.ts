import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NeoConfigSchema, silentLogger, type NeoConfig } from '@neo/protocol';
import { createConversationStore, createSettingsStore, migrate, openDatabase, storageMigrations } from '@neo/storage';
import { createApp } from './app.js';
import { createServices } from './services.js';
import type { NeoServices } from './index.js';

const resources: NeoServices[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const services of resources.splice(0)) await services.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(providers: NeoConfig['providers'] = []) {
  const services = await createServices(NeoConfigSchema.parse({ providers, log: { level: 'silent' } }), { inMemory: true, logger: silentLogger });
  resources.push(services);
  return services;
}

function request(services: NeoServices, path: string, body?: unknown, method = 'POST', accept?: string) {
  return createApp(services).app.request(`/api${path}`, {
    method, headers: { Authorization: `Bearer ${services.ownerToken}`, 'Content-Type': 'application/json', ...(accept ? { Accept: accept } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('no AI connected', () => {
  it('does not reapply retired demo capability settings from first-boot configuration', async () => {
    const ref = { provider: 'demo', model: 'neo-demo' };
    const services = await createServices(NeoConfigSchema.parse({ settings: { ai: { capabilities: { text: ref, embedding: ref, image: ref } } }, log: { level: 'silent' } }), { inMemory: true, logger: silentLogger });
    resources.push(services);
    expect(Object.values(services.settings.get().ai.capabilities)).toEqual([null, null, null, null, null, null]);
    expect(services.settings.get()).toMatchObject({ defaultModel: null, memoryModel: null, embedding: null });
  });

  it.each([
    { name: 'fresh install', providers: [] },
    { name: 'disabled provider', providers: [{ id: 'local', kind: 'ollama', enabled: false, defaultModel: 'model' }] },
    { name: 'provider without a default model', providers: [{ id: 'local', kind: 'ollama', enabled: true }] },
    { name: 'configured mock', providers: [{ id: 'test-double', kind: 'mock', enabled: true, defaultModel: 'neo-test' }] },
    { name: 'legacy demo', providers: [{ id: 'demo', kind: 'mock', enabled: true, defaultModel: 'neo-demo' }] },
  ] satisfies { name: string; providers: NeoConfig['providers'] }[])('fails fast for $name without changing the transcript or conversation', async ({ providers }) => {
    const services = await fixture(providers);
    const conversation = services.conversations.create({ title: 'Existing chat' });
    services.conversations.appendMessage({ id: 'history', conversationId: conversation.id, role: 'user', parts: [{ type: 'text', text: 'Existing transcript' }], createdAt: 1, status: 'complete' });
    const storedConversation = services.conversations.get(conversation.id);
    const transcript = services.db!.prepare('SELECT * FROM messages').all();
    for (const accept of ['application/json', 'text/event-stream']) {
      const response = await request(services, '/timeline/messages', { text: 'Hello' }, 'POST', accept);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'no_provider', message: 'Connect an AI to start chatting. Open Settings → AI to add a provider.' });
      expect(services.runtime.activeTurns()).toEqual([]);
      expect(services.db!.prepare('SELECT * FROM messages').all()).toEqual(transcript);
      expect(services.conversations.get(conversation.id)).toEqual(storedConversation);
    }
  });

  it('rejects mock creation, draft testing, kind changes, enabling and model selection with bad_request', async () => {
    const services = await fixture();
    services.providerConfigs.upsert({ id: 'retired-test', kind: 'mock', enabled: false });
    services.providerConfigs.upsert({ id: 'local', kind: 'ollama', enabled: true, defaultModel: 'model' });
    for (const [path, method, body] of [
      ['/providers', 'POST', { kind: 'mock', apiKey: 'must-not-persist' }],
      ['/providers', 'POST', { kind: 'mock', enabled: false }],
      ['/providers/test', 'POST', { kind: 'mock' }],
      ['/providers/local', 'PATCH', { kind: 'mock' }],
      ['/providers/retired-test', 'PATCH', { enabled: true }],
      ['/settings', 'PATCH', { defaultModel: { provider: 'retired-test', model: 'neo-test' } }],
      ['/settings', 'PATCH', { memoryModel: { provider: 'retired-test', model: 'neo-test' } }],
      ['/settings', 'PATCH', { embedding: { provider: 'retired-test', model: 'neo-test' } }],
    ] as const) {
      const response = await request(services, path, body, method);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'bad_request', message: expect.stringContaining('internal tests') });
    }
    expect(services.secrets.list()).toEqual([]);
    expect(services.providerConfigs.get('retired-test')?.enabled).toBe(false);
    const listed = await request(services, '/providers', undefined, 'GET');
    expect(await listed.json()).toMatchObject({ items: [{ id: 'local' }] });
    const tested = await request(services, '/providers/retired-test/test');
    expect(tested.status).toBe(404);
  });

  it('keeps explicit internal mock options out of settings and provider APIs', async () => {
    const services = await createServices(NeoConfigSchema.parse({}), {
      inMemory: true, logger: silentLogger,
      mockProviders: [{ id: 'internal', kind: 'mock', enabled: true, defaultModel: 'neo-test' }],
      mockScript: () => ({ text: 'Scripted test reply' }),
    });
    resources.push(services);
    expect(services.providers.get('internal')?.kind).toBe('mock');
    expect(await (await request(services, '/providers', undefined, 'GET')).json()).toMatchObject({ items: [] });
    expect((await request(services, '/providers/internal/test')).status).toBe(404);
    const updated = await request(services, '/settings', { defaultModel: { provider: 'internal', model: 'neo-test' } }, 'PATCH');
    expect(updated.status).toBe(400);
    expect(await updated.json()).toMatchObject({ code: 'bad_request' });
    const conversation = services.conversations.create();
    expect((await (await services.runtime.send({ conversationId: conversation.id, parts: [{ type: 'text', text: 'Hello' }] })).done).status).toBe('complete');
  });

  it.each([false, true])('migrates previously selected implicit demo on startup while preserving transcript bytes (real id demo=%s)', async (realProvider) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'neo-no-demo-upgrade-'));
    directories.push(dataDir);
    const db = openDatabase(join(dataDir, 'neo.db'));
    migrate(db, 'storage', storageMigrations.filter(migration => migration.version <= 3));
    const ref = { provider: 'demo', model: 'neo-demo' };
    createSettingsStore(db).update({ defaultModel: ref, memoryModel: ref, embedding: ref });
    const conversation = createConversationStore(db).create({ model: ref });
    createConversationStore(db).appendMessage({ id: 'old-demo-message', conversationId: conversation.id, role: 'assistant', parts: [{ type: 'text', text: 'Historical answer' }], createdAt: 1, status: 'complete', model: ref });
    const transcript = db.prepare('SELECT * FROM messages').all();
    db.close();
    const services = await createServices(NeoConfigSchema.parse({ dataDir, providers: realProvider ? [{ id: 'demo', kind: 'ollama', enabled: true, defaultModel: 'neo-demo' }] : [], log: { level: 'silent' } }), { logger: silentLogger });
    resources.push(services);
    expect(services.settings.get()).toMatchObject({ defaultModel: realProvider ? ref : null, memoryModel: realProvider ? ref : null, embedding: realProvider ? ref : null });
    expect(services.conversations.get(conversation.id)?.model).toEqual(realProvider ? ref : null);
    expect(services.db!.prepare('SELECT * FROM messages').all()).toEqual(transcript);
    expect(services.providers.get('demo')?.kind).toBe(realProvider ? 'ollama' : undefined);
  });
});
