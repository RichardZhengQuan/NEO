/** Composition root: construct concrete services, then connect their protocol events. */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConsoleLogger, NeoError, randomToken, systemClock } from '@neo/protocol';
import type { Embedder, NeoConfig } from '@neo/protocol';
import {
  createConversationStore, createDeviceStore, createProviderConfigStore,
  createPushSubscriptionStore, createSecretStore, createSettingsStore,
  loadOrCreateKey, migrate, openNeoDatabase,
  protectProviderHeaders, resolveStoredProviderHeaders,
} from '@neo/storage';
import { createProviderRegistry } from '@neo/providers';
import { createMemoryService, createProviderEmbedder, HashingEmbedder, memoryMigrations } from '@neo/memory';
import type { MemoryLLM } from '@neo/memory';
import {
  createBuiltinTools, createProductivityStores, createReminderScheduler,
  createToolRegistry, loadPlugins, toolsMigrations,
} from '@neo/tools';
import { createAgentRuntime } from '@neo/core';
import { expandTilde } from './config.js';
import { EventHub } from './events.js';
import { createNotifier, loadOrCreateVapidKeys } from './notifier.js';
import type { CreateServicesOptions, NeoServices } from './index.js';
import { pushAllowedHosts } from './push-policy.js';

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
  };
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
    const settings = createSettingsStore(db);
    // Existence of the row, rather than onboarding state, defines first boot.
    if (!db.prepare('SELECT 1 FROM settings WHERE key = ?').get('settings')) {
      settings.update({
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: environmentLocale(),
        ...config.settings,
      });
    }
    const conversations = createConversationStore(db, { clock });
    const devices = createDeviceStore(db);
    const push = createPushSubscriptionStore(db);
    const providerConfigs = createProviderConfigStore(db, secrets);
    config.providers = config.providers.map(provider => protectProviderHeaders(provider, secrets));

    const tokenPath = join(dataDir, 'token');
    let ownerToken = config.server.authToken;
    if (!ownerToken && !inMemory && existsSync(tokenPath)) ownerToken = readFileSync(tokenPath, 'utf8').trim() || undefined;
    if (!ownerToken) {
      ownerToken = randomToken();
      if (!inMemory) writeFileSync(tokenPath, ownerToken, { mode: 0o600 });
    }
    if (!devices.verify(ownerToken)?.owner) devices.replaceOwner(ownerToken);

    const providers = createProviderRegistry([...config.providers, ...providerConfigs.list()].map(provider => resolveStoredProviderHeaders(provider, secrets)), {
      resolveSecret: (name) => secrets.get(name), logger,
      ...(options.mockScript ? { mockScript: options.mockScript } : {}),
    });
    const initial = settings.get();
    const embedding = initial.embedding;
    // An unusable embedding configuration (provider deleted, or one without embeddings) must never keep
    // the server from starting: fall back to the offline embedder and say so.
    const embedder = ((): Embedder => {
      if (!embedding) return new HashingEmbedder(512);
      const adapter = providers.get(embedding.provider);
      try {
        if (!adapter) throw new NeoError('config_error', `Embedding provider "${embedding.provider}" not found.`);
        return createProviderEmbedder(adapter, embedding.model);
      } catch (err) {
        logger.warn('Embedding settings are unusable; using the offline embedder instead.', { error: NeoError.from(err).message });
        return new HashingEmbedder(512);
      }
    })();
    const llm = (): MemoryLLM | null => {
      try {
        const s = settings.get();
        const ref = s.memoryModel ?? s.defaultModel;
        if (ref) {
          const { adapter, model } = providers.resolve(ref);
          return { model: adapter, name: model, isLocal: adapter.isLocal };
        }
        // Use persisted/config enabled flags: some adapters normalize disabled config.
        const enabled = [...config.providers, ...providerConfigs.list()].find(p => p.enabled && p.defaultModel);
        if (!enabled?.defaultModel) return null;
        const { adapter, model } = providers.resolve({ provider: enabled.id, model: enabled.defaultModel });
        return { model: adapter, name: model, isLocal: adapter.isLocal };
      } catch { return null; }
    };
    const memory = createMemoryService({ db, embedder, llm, policy: initial.memory, clock, logger });
    const stores = createProductivityStores(db, { clock, defaultTimezone: initial.timezone });
    const tools = createToolRegistry({ permissions: initial.tools.permissions, logger });
    for (const tool of createBuiltinTools({ stores, memory, webSearch: config.webSearch, allowPrivateNetwork: config.mode === 'local', clock })) {
      tools.register(tool, 'builtin');
    }
    if (config.plugins.enabled) {
      for (const plugin of await loadPlugins(config.plugins.dir ?? join(dataDir, 'plugins'), logger)) {
        for (const tool of plugin.tools ?? []) tools.register(tool, 'plugin');
      }
    }
    const runtime = createAgentRuntime({ conversations, settings, providers, memory, tools, logger, clock });
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
    const events = new EventHub(clock);
    let vapidKeys: ReturnType<typeof loadOrCreateVapidKeys> | null = null;
    try {
      vapidKeys = loadOrCreateVapidKeys(dataDir, config.push, { inMemory });
      config.push.vapidPublicKey = vapidKeys.publicKey;
      config.push.vapidPrivateKey = vapidKeys.privateKey;
    } catch (err) { logger.warn('Failed to load VAPID keys', { error: String(err) }); }
    const notifier = createNotifier({ notifications: stores.notifications, push, devices, events, logger, clock, vapidKeys, pushSubject: config.push.subject, allowedHosts: pushAllowedHosts(config) });
    const notify = notifier.notify.bind(notifier);
    notifier.notify = input => track(notify(input));
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
      events.publish({ type: 'settings.updated', settings: s });
    }));
    subscriptions.push(scheduler.onFire(firing => {
      events.publish({ type: 'reminder.fired', firing });
      void notifier.notify({
        kind: 'reminder', title: firing.reminder.title,
        body: firing.missed ? `Missed while you were away: ${firing.reminder.title}` : (firing.reminder.notes || "It's time"),
        data: { reminderId: firing.reminder.id, url: `neo://reminders/${firing.reminder.id}` },
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
          for (const unsubscribe of subscriptions) unsubscribe();
          db.close();
        })();
      }
      return closePromise;
    }
    return { config, logger, clock, ownerToken, db, conversations, settings, secrets, devices, push, providerConfigs, providers, memory, tools, stores, scheduler, runtime, events, notifier, close };
  } catch (err) {
    scheduler?.stop();
    for (const unsubscribe of subscriptions) unsubscribe();
    db.close();
    throw NeoError.from(err, 'config_error');
  }
}
