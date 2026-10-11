import { vi } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_CAPABILITIES, DEFAULT_MEMORY_POLICY, NeoConfigSchema, NeoError, MemoryNodeSchema,
  newId, silentLogger,
} from '@neo/protocol';
import type {
  AgentEvent, AgentRuntimeApi, MemoryService, Message, ProviderAdapter, ProviderConfig,
  ProviderRegistry, TurnHandle, ToolConfirmation,
} from '@neo/protocol';
import {
  openNeoDatabase, migrate, createConversationStore, createSettingsStore, createSecretStore,
  createDeviceStore, createPushSubscriptionStore, createProviderConfigStore,
} from '@neo/storage';
import { createProductivityStores, createToolRegistry, toolsMigrations } from '@neo/tools';
import { EventHub } from './events.js';
import type { NeoServices } from './index.js';
import { createApp } from './app.js';

export const OWNER_TOKEN = 'owner-token-for-route-tests';

export function routeFixture(configInput: unknown = {}) {
  const config = NeoConfigSchema.parse({ providers: [], ...configInput as object });
  const time = { now: Date.parse('2026-10-10T12:00:00Z') };
  const clock = () => time.now;
  const db = openNeoDatabase(':memory:');
  migrate(db, 'tools', toolsMigrations);
  const conversations = createConversationStore(db, { clock });
  const settings = createSettingsStore(db);
  settings.update({ timezone: 'Asia/Singapore' });
  const secrets = createSecretStore(db, new Uint8Array(32).fill(7));
  const devices = createDeviceStore(db);
  devices.create({ name: 'owner', platform: 'other', owner: true, token: OWNER_TOKEN });
  const push = createPushSubscriptionStore(db);
  const providerConfigs = createProviderConfigStore(db, secrets);
  const stores = createProductivityStores(db, { clock });
  const events = new EventHub();
  const tools = createToolRegistry();
  tools.register({
    name: 'read_test', title: 'Read test', description: 'Fixture tool', risk: 'read',
    defaultPermission: 'auto', inputSchema: z.object({}), execute: async () => ({ output: 'ok' }),
  });
  tools.register({
    name: 'delete_test', title: 'Delete test', description: 'Fixture destructive tool', risk: 'dangerous',
    defaultPermission: 'confirm', inputSchema: z.object({}), execute: async () => ({ output: 'ok' }),
  }, 'plugin');
  let policy = DEFAULT_MEMORY_POLICY;
  const nodes = new Map<string, ReturnType<typeof MemoryNodeSchema.parse>>();
  const report = {
    id: 'cons_1', startedAt: clock(), finishedAt: clock(), archived: 0, edgesDecayed: 0,
    edgesPruned: 0, episodesConsolidated: 0, factsCreated: 0, linksCreated: 0, entitiesMerged: 0, notes: [],
  };
  const memory: MemoryService = {
    recall: vi.fn(async () => ({ items: [], tookMs: 0, seeds: 0, considered: 0 })),
    observe: vi.fn(async () => ({ created: [], updated: [], superseded: [], pending: [], linked: 0 })),
    remember: vi.fn(async (input) => {
      const node = MemoryNodeSchema.parse({
        id: newId('mem', clock()), content: input.content, label: input.label ?? input.content,
        kind: input.kind ?? 'fact', tags: input.tags ?? [], pinned: input.pinned ?? false,
        importance: .5, confidence: 1, stability: 30, accessCount: 0, lastAccessedAt: null,
        createdAt: clock(), updatedAt: clock(), status: 'active', sensitivity: 'normal',
        source: input.source ?? { by: 'user' },
      });
      nodes.set(node.id, node);
      return node;
    }),
    search: vi.fn(async (query) => {
      const all = [...nodes.values()].filter((n) => !query.query || n.content.includes(query.query));
      return { items: all, total: all.length };
    }),
    get: vi.fn(async (id) => {
      const node = nodes.get(id);
      return node ? { node, retention: 1, edges: [], neighbors: [], history: [] } : null;
    }),
    update: vi.fn(async (id, patch) => {
      const node = nodes.get(id);
      if (!node) throw new NeoError('not_found', 'Memory not found');
      const next = { ...node, ...patch };
      nodes.set(id, next);
      return next;
    }),
    forget: vi.fn(async (ids: string[]) => ids.reduce((count, id) => count + Number(nodes.delete(id)), 0)),
    findForForget: vi.fn(async () => [...nodes.values()]),
    approve: vi.fn(async (ids) => ids.length), reject: vi.fn(async (ids) => ids.length),
    link: vi.fn(async (from, to, type, weight) => ({
      id: 'edge_1', from, to, type, weight: weight ?? .5, createdAt: clock(), updatedAt: clock(),
      lastReinforcedAt: clock(), coactivations: 0,
    })),
    unlink: vi.fn(async (id) => id === 'edge_1'),
    graph: vi.fn(async () => ({ nodes: [...nodes.values()].map((node) => ({ ...node, retention: 1 })), edges: [] })),
    consolidate: vi.fn(async () => report), journal: vi.fn(async () => [report]),
    stats: vi.fn(async () => ({
      total: nodes.size, byKind: { episode: 0, fact: nodes.size, entity: 0, preference: 0, skill: 0, goal: 0, summary: 0 },
      byStatus: { active: nodes.size, pending: 0, archived: 0, superseded: 0 }, edges: 0, pending: 0,
      lastConsolidationAt: null, embeddingModel: 'fake',
    })),
    export: vi.fn(async () => ({ format: 'neo-memory' as const, version: 1 as const, exportedAt: clock(), nodes: [...nodes.values()], edges: [] })),
    import: vi.fn(async (data) => ({ nodes: data.nodes.length, edges: data.edges.length, skipped: 0 })),
    getPolicy: () => policy, setPolicy: vi.fn((next) => { policy = next; }), onChange: () => () => {},
  };
  const adapters = new Map<string, ProviderAdapter>();
  const adapter = (config: ProviderConfig): ProviderAdapter => ({
    id: config.id, kind: config.kind, config, isLocal: config.local ?? config.kind === 'mock',
    async *chat() { yield { type: 'done', stopReason: 'end' }; },
    capabilities: () => DEFAULT_CAPABILITIES,
    listModels: vi.fn(async () => [{ id: config.defaultModel ?? 'model', provider: config.id, capabilities: DEFAULT_CAPABILITIES }]),
    test: vi.fn(async () => ({ ok: true, latencyMs: 0, models: [config.defaultModel ?? 'model'] })),
  });
  const providers: ProviderRegistry = {
    get: vi.fn((id) => adapters.get(id)), list: () => [...adapters.values()],
    resolve: (ref) => {
      const found = adapters.get(ref.provider);
      if (!found) throw new NeoError('not_found', 'Provider not found');
      return { adapter: found, model: ref.model };
    },
    upsert: vi.fn((config) => { const result = adapter(config); adapters.set(config.id, result); return result; }),
    remove: vi.fn((id) => adapters.delete(id)),
  };
  config.providers.forEach((config) => providers.upsert(config));
  const confirmations = new Map<string, ToolConfirmation>();
  const runtime: AgentRuntimeApi = {
    send: vi.fn(async (input): Promise<TurnHandle> => {
      const turnId = newId('turn', clock());
      const userMessage: Message = {
        id: newId('msg', clock()), conversationId: input.conversationId, role: 'user',
        parts: input.parts, createdAt: clock(), status: 'complete', turnId,
      };
      const assistant: Message = {
        id: newId('msg', clock()), conversationId: input.conversationId, role: 'assistant',
        parts: [{ type: 'text', text: 'Hello from scripted runtime' }], createdAt: clock(), status: 'complete', turnId,
      };
      conversations.appendMessage(userMessage);
      conversations.appendMessage(assistant);
      const scope = { turnId, conversationId: input.conversationId };
      const scripted: AgentEvent[] = [
        { type: 'turn.started', ...scope, userMessage, assistantMessageId: assistant.id, model: { provider: 'fake', model: 'model' } },
        { type: 'text.delta', ...scope, messageId: assistant.id, text: 'Hello from scripted runtime' },
        { type: 'message.completed', ...scope, message: assistant },
        { type: 'turn.finished', ...scope, stopReason: 'end', usage: null },
      ];
      return {
        turnId, conversationId: input.conversationId, userMessage, assistantMessageId: assistant.id,
        events: (async function* () { yield* scripted; })(), done: Promise.resolve(assistant),
      };
    }),
    cancel: vi.fn(() => true), cancelConversation: vi.fn(() => true),
    confirm: vi.fn((id) => confirmations.delete(id)), pendingConfirmations: () => [...confirmations.values()],
    handleUiAction: vi.fn(async () => ({ kind: 'noop' as const })), subscribe: () => () => {}, activeTurns: vi.fn(() => []),
  };
  settings.onChange((next) => {
    memory.setPolicy(next.memory);
    for (const [name, permission] of Object.entries(next.tools.permissions)) tools.setPermission(name, permission);
    events.publish({ type: 'settings.updated', settings: next });
  });
  stores.reminders.onChange((e) => events.publish(e.type === 'upsert'
    ? { type: 'reminder.updated', reminder: e.reminder } : { type: 'reminder.deleted', reminderId: e.id }));
  stores.tasks.onChange((e) => events.publish(e.type === 'upsert'
    ? { type: 'task.updated', task: e.task } : { type: 'task.deleted', taskId: e.id }));
  stores.notes.onChange((e) => events.publish(e.type === 'upsert'
    ? { type: 'note.updated', note: e.note } : { type: 'note.deleted', noteId: e.id }));
  const services: NeoServices = {
    config, clock, logger: silentLogger, ownerToken: OWNER_TOKEN, db,
    conversations, settings, secrets, devices, push, providerConfigs, stores, tools, providers, memory,
    events, runtime,
    scheduler: { start: vi.fn(), stop: vi.fn(), tick: () => [], reschedule: vi.fn(), onFire: () => () => {} },
    notifier: { notify: async (input) => stores.notifications.create(input) },
    close: async () => db.close(),
  };
  const { app } = createApp(services);
  function request(path: string, method = 'GET', body?: unknown, token: string | null = OWNER_TOKEN, extraHeaders: Record<string, string> = {}) {
    return app.request(path, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  return { services, app, request, time, nodes, confirmations };
}
