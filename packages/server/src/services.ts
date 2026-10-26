/** Composition root: construct concrete services, then connect their protocol events. */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI_CAPABILITIES, applySettingsPatch, createConsoleLogger, NeoError, randomToken, systemClock } from '@neo/protocol';
import type { Embedder, NeoConfig } from '@neo/protocol';
import {
  createConversationStore, createDeviceStore, createProviderConfigStore,
  createPushSubscriptionStore, createSecretStore, createSettingsStore,
  loadOrCreateKey, migrate, openNeoDatabase,
  protectProviderHeaders, resolveStoredProviderHeaders, retireLegacyDemoProvider,
} from '@neo/storage';
import { createProviderRegistry } from '@neo/providers';
import { createMemoryService, createProviderEmbedder, HashingEmbedder, memoryMigrations } from '@neo/memory';
import type { MemoryLLM } from '@neo/memory';
import {
  createBuiltinTools, createProductivityStores, createReminderScheduler,
  createToolRegistry, createWebSearchTool, loadPlugins, toolsMigrations,
} from '@neo/tools';
import { createAgentRuntime } from '@neo/core';
import { clearDemoSettings, expandTilde, removeLegacyDemo } from './config.js';
import { EventHub } from './events.js';
import { createNotifier, loadOrCreateVapidKeys } from './notifier.js';
import type { CreateServicesOptions, NeoServices } from './index.js';
import { pushAllowedHosts } from './push-policy.js';
import { migratePersonaSettings, storedPersona } from './persona-migration.js';
import { createChatGPTTokenManager } from './chatgpt-auth.js';
import { prepareSearchPatch, resolveSearchEngine, settingsView } from './search-settings.js';

/** POSIX locale names become canonical BCP-47 tags; C/POSIX has no language. */
export function environmentLocale(env: Record<string, string | undefined> = process.env): string {
  const value = (env['LC_ALL'] || env['LANG'] || '').split(/[.@]/, 1)[0]!.replace(/_/g, '-');
  if (!value || /^(C|POSIX)$/i.test(value)) return 'en';
  try { return Intl.getCanonicalLocales(value)[0] ?? 'en'; } catch { return 'en'; }
}

export async function createServices(input: NeoConfig, options: CreateServicesOptions = {}): Promise<NeoServices> {
  const config: NeoConfig = {
    ...input,
    dataDir: expandTilde(input.dataDir),
    server: { ...input.server, webDir: input.server.webDir === null ? null : expandTilde(input.server.webDir) },
    push: { ...input.push },
    plugins: { ...input.plugins, ...(input.plugins.dir ? { dir: expandTilde(input.plugins.dir) } : {}) },
    settings: structuredClone(input.settings),
  };
  removeLegacyDemo(config);
  // Mock adapters are an explicit test dependency, never a user-configured AI.
  config.providers = config.providers.filter(provider => provider.kind !== 'mock');
  const mockProviders = options.mockProviders ?? [];
  if (mockProviders.some(provider => provider.kind !== 'mock') || (mockProviders.length && !options.mockScript)) {
    throw new NeoError('config_error', 'Internal mock providers require an explicit script and kind mock.');
  }
  const logger = options.logger ?? createConsoleLogger(config.log.level);
  const clock = options.clock ?? systemClock;
  const inMemory = options.inMemory ?? false;
  const { dataDir } = config;
  const db = (() => {
    try {
      if (!inMemory) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      return openNeoDatabase(inMemory ? ':memory:' : join(dataDir, 'neo.db'));
    } catch (err) { throw NeoError.from(err, 'config_error'); }
  })();
  const subscriptions: (() => void)[] = [];
  let scheduler: NeoServices['scheduler'] | undefined;
  try {
    migrate(db, 'memory', memoryMigrations);
    migrate(db, 'tools', toolsMigrations);
    const secrets = createSecretStore(db, inMemory ? randomBytes(32) : loadOrCreateKey(join(dataDir, 'key')));
    const providerConfigs = createProviderConfigStore(db, secrets);
    if (![...config.providers, ...providerConfigs.list()].some(provider => provider.id === 'demo' && provider.kind !== 'mock')) {
      retireLegacyDemoProvider(db, true);
      if (config.settings) clearDemoSettings(config.settings);
    }
    let legacyPersona = storedPersona(db);
    const settings = createSettingsStore(db);
    if (![...config.providers, ...providerConfigs.list()].some(provider => provider.id === 'demo' && provider.kind !== 'mock')) {
      const capabilities = { ...settings.get().ai.capabilities };
      let retired = false;
      for (const capability of AI_CAPABILITIES) {
        if (capabilities[capability]?.provider === 'demo') { capabilities[capability] = null; retired = true; }
      }
      if (retired) settings.update({ ai: { capabilities } });
    }
    // Existence of the row, rather than onboarding state, defines first boot.
    if (!db.prepare('SELECT 1 FROM settings WHERE key = ?').get('settings')) {
      legacyPersona = config.settings?.persona;
      db.transaction(() => {
        const prepared = prepareSearchPatch(settings.get(), {
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: environmentLocale(),
          ...config.settings,
        }, secrets);
        applySettingsPatch(settings.get(), prepared.patch);
        prepared.commit();
        const saved = settings.update(prepared.patch);
        if (legacyPersona && typeof legacyPersona === 'object' && !Array.isArray(legacyPersona)) {
          db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
            JSON.stringify({ ...saved, persona: { ...legacyPersona, avatar: saved.persona.avatar } }), 'settings',
          );
        }
      });
    }
    const conversations = createConversationStore(db, { clock });
    const devices = createDeviceStore(db);
    const push = createPushSubscriptionStore(db);
    config.providers = config.providers.map(provider => protectProviderHeaders(provider, secrets));

    const tokenPath = join(dataDir, 'token');
    let ownerToken = config.server.authToken;
    if (!ownerToken && !inMemory && existsSync(tokenPath)) ownerToken = readFileSync(tokenPath, 'utf8').trim() || undefined;
    if (!ownerToken) {
      ownerToken = randomToken();
      if (!inMemory) writeFileSync(tokenPath, ownerToken, { mode: 0o600 });
    }
    if (!devices.verify(ownerToken)?.owner) devices.replaceOwner(ownerToken);

    const chatGPTTokens = createChatGPTTokenManager(secrets, options.chatGPT, clock);
    const providers = createProviderRegistry([...config.providers, ...providerConfigs.list().filter(provider => provider.kind !== 'mock'), ...mockProviders].map(provider => resolveStoredProviderHeaders(provider, secrets)), {
      resolveSecret: (name) => secrets.get(name), logger,
      getChatGPTAccessToken: (id) => chatGPTTokens.accessToken(id),
      onChatGPTUnauthorized: (id, token) => chatGPTTokens.markNeedsReauthorization(id, token),
      ...(options.mockScript ? { mockScript: options.mockScript } : {}),
    });
    const initial = settings.get();
    // An unusable embedding configuration (provider deleted, disabled, or one without embeddings) must
    // never keep the server from starting: fall back to the offline embedder and say so.
    // Uses providers.resolve() (not .get()) so that disabled providers are rejected before use.
    function buildEmbedder(embedding: { provider: string; model: string } | null | undefined): Embedder {
      if (!embedding) return new HashingEmbedder(512);
      try {
        const { adapter } = providers.resolve({ provider: embedding.provider, model: embedding.model });
        return createProviderEmbedder(adapter, embedding.model);
      } catch (err) {
        logger.warn('Embedding settings are unusable; using the offline embedder instead.', { error: NeoError.from(err).message });
        return new HashingEmbedder(512);
      }
    }
    const embedder = buildEmbedder(initial.ai.capabilities.embedding);
    let embeddingKey = JSON.stringify(initial.ai.capabilities.embedding ?? null);
    const llm = (): MemoryLLM | null => {
      try {
        const s = settings.get();
        const ref = s.ai.capabilities.text;
        if (ref) {
          const { adapter, model } = providers.resolve(ref);
          return { model: adapter, name: model, isLocal: adapter.isLocal };
        }
        // Use persisted/config enabled flags: some adapters normalize disabled config.
        const enabled = [...config.providers, ...providerConfigs.list().filter(provider => provider.kind !== 'mock'), ...mockProviders].find(p => p.enabled && p.defaultModel);
        if (!enabled?.defaultModel) return null;
        const { adapter, model } = providers.resolve({ provider: enabled.id, model: enabled.defaultModel });
        return { model: adapter, name: model, isLocal: adapter.isLocal };
      } catch { return null; }
    };
    const memory = createMemoryService({ db, embedder, llm, policy: initial.memory, clock, logger });
    await migratePersonaSettings(db, memory, settings, legacyPersona, clock, logger);
    const refreshEmbeddingProvider = (providerId: string): void => {
      const embedding = settings.get().ai.capabilities.embedding;
      if (embedding?.provider === providerId) memory.setEmbedder(buildEmbedder(embedding));
    };
    const stores = createProductivityStores(db, { clock, defaultTimezone: initial.timezone });
    const tools = createToolRegistry({ permissions: initial.tools.permissions, logger });
    for (const tool of createBuiltinTools({ stores, memory, allowPrivateNetwork: config.mode === 'local', clock })) {
      tools.register(tool, 'builtin');
    }
    if (config.plugins.enabled) {
      for (const plugin of await loadPlugins(config.plugins.dir ?? join(dataDir, 'plugins'), logger)) {
        for (const tool of plugin.tools ?? []) tools.register(tool, 'plugin');
      }
    }
    const runtime = createAgentRuntime({ conversations, reminders: stores.reminders, settings, providers, memory, tools, logger, clock,
      resolveSearchTool: current => {
        const engine = resolveSearchEngine(current, config.webSearch, secrets);
        return engine ? createWebSearchTool(engine) : undefined;
      },
    });
    await runtime.purgeOffRecord(clock() - 12 * 60 * 60_000);
    // Core starts observation after the reply; keep that work alive until shutdown.
    const pending = new Set<Promise<unknown>>();
    const track = <T>(promise: Promise<T>): Promise<T> => {
      pending.add(promise);
      void promise.then(() => { pending.delete(promise); }, () => { pending.delete(promise); });
      return promise;
    };
    const observe = memory.observe.bind(memory);
    memory.observe = turn => track(observe(turn));
    const consolidate = memory.consolidate.bind(memory);
    memory.consolidate = options => track(consolidate(options));
    let closing = false;
    const send = runtime.send.bind(runtime);
    runtime.send = async input => {
      if (closing) throw new NeoError('cancelled', 'The server is stopping.');
      const turn = await track(send(input));
      track(turn.done);
      if (closing) runtime.cancel(turn.turnId);
      return turn;
    };
    const sendTimeline = runtime.sendTimeline.bind(runtime);
    runtime.sendTimeline = async input => {
      if (closing) throw new NeoError('cancelled', 'The server is stopping.');
      const turn = await track(sendTimeline(input));
      track(turn.done);
      if (closing) runtime.cancel(turn.turnId);
      return turn;
    };
    const purgeTimer = setInterval(() => {
      if (!closing) void track(runtime.purgeOffRecord(clock() - 12 * 60 * 60_000)).catch(error => {
        logger.warn('Off-record cleanup failed', { error: String(error) });
      });
    }, 60_000);
    purgeTimer.unref();
    subscriptions.push(() => clearInterval(purgeTimer));
    const events = new EventHub(clock);
    let vapidKeys: ReturnType<typeof loadOrCreateVapidKeys> | null = null;
    try {
      vapidKeys = loadOrCreateVapidKeys(dataDir, config.push, { inMemory });
      config.push.vapidPublicKey = vapidKeys.publicKey;
      config.push.vapidPrivateKey = vapidKeys.privateKey;
    } catch (err) { logger.warn('Failed to load VAPID keys', { error: String(err) }); }
    const notifier = createNotifier({ notifications: stores.notifications, push, devices, conversations, events, logger, clock, vapidKeys, pushSubject: config.push.subject, allowedHosts: pushAllowedHosts(config) });
    const notify = notifier.notify.bind(notifier);
    notifier.notify = (input, options) => track(notify(input, options));
    scheduler = createReminderScheduler({ reminders: stores.reminders, clock, logger });

    subscriptions.push(runtime.subscribe(event => { events.publish(event); }));
    subscriptions.push(memory.onChange(change => { events.publish({ type: 'memory.changed', change }); }));
    subscriptions.push(stores.reminders.onChange(e => {
      events.publish(e.type === 'upsert' ? { type: 'reminder.updated', reminder: e.reminder } : { type: 'reminder.deleted', reminderId: e.id });
    }));
    subscriptions.push(stores.tasks.onChange(e => {
      events.publish(e.type === 'upsert' ? { type: 'task.updated', task: e.task } : { type: 'task.deleted', taskId: e.id });
    }));
    subscriptions.push(stores.notes.onChange(e => {
      events.publish(e.type === 'upsert' ? { type: 'note.updated', note: e.note } : { type: 'note.deleted', noteId: e.id });
    }));
    subscriptions.push(settings.onChange(s => {
      memory.setPolicy(s.memory);
      for (const [name, permission] of Object.entries(s.tools.permissions)) tools.setPermission(name, permission);
      events.publish({ type: 'settings.updated', settings: settingsView(s, secrets) });
      // A new embedding choice takes effect now, not at the next restart (re-embedding happens in the background).
      const nextEmbeddingKey = JSON.stringify(s.ai.capabilities.embedding ?? null);
      if (nextEmbeddingKey !== embeddingKey) {
        embeddingKey = nextEmbeddingKey;
        memory.setEmbedder(buildEmbedder(s.ai.capabilities.embedding));
      }
    }));
    subscriptions.push(scheduler.onFire(firing => {
      events.publish({ type: 'reminder.fired', firing });
      void notifier.notify({
        kind: 'reminder', title: firing.reminder.title,
        body: firing.missed ? `Missed while you were away: ${firing.reminder.title}` : (firing.reminder.notes || "It's time"),
        data: {
          reminderId: firing.reminder.id,
          ...(firing.reminder.messageId ? { messageId: firing.reminder.messageId, url: `neo://timeline/${encodeURIComponent(firing.reminder.messageId)}` }
            : { url: `neo://reminders/${firing.reminder.id}` }),
        },
      }, firing.pendingFiringId ? { idempotencyKey: firing.pendingFiringId } : undefined).then(() => {
        if (firing.pendingFiringId) stores.reminders.clearPendingFiring?.(firing.pendingFiringId);
      }).catch(err => { logger.warn('Reminder notification failed', { error: String(err) }); });
    }));

    let closePromise: Promise<void> | null = null;
    function close(): Promise<void> {
      if (!closePromise) {
        closing = true;
        scheduler!.stop();
        for (const turn of runtime.activeTurns()) runtime.cancel(turn.turnId);
        closePromise = (async () => {
          while (pending.size) await Promise.allSettled([...pending]);
          await chatGPTTokens.close();
          for (const unsubscribe of subscriptions) unsubscribe();
          db.close();
        })();
      }
      return closePromise;
    }
    return { config, ...(options.openRouter ? { openRouter: options.openRouter } : {}), ...(options.chatGPT ? { chatGPT: options.chatGPT } : {}), chatGPTTokens, logger, clock, ownerToken, db, conversations, settings, secrets, devices, push, providerConfigs, providers, refreshEmbeddingProvider, memory, tools, stores, scheduler, runtime, events, notifier, close };
  } catch (err) {
    scheduler?.stop();
    for (const unsubscribe of subscriptions) unsubscribe();
    db.close();
    throw NeoError.from(err, 'config_error');
  }
}
