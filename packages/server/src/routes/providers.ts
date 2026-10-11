import type { Hono } from 'hono';
import { CreateProviderRequestSchema, NeoError, TestProviderRequestSchema, UpdateProviderRequestSchema, isLocalUrl } from '@neo/protocol';
import type { NeoSettingsPatch, ProviderConfig, ProviderView, SecretStore } from '@neo/protocol';
import { createProvider } from '@neo/providers';
import { isSecretProviderHeader, protectProviderHeaders, resolveStoredProviderHeaders } from '@neo/storage';
import type { NeoServices } from '../index.js';
import { validateBody } from './helpers.js';

/** Derive an id from provider kind, avoiding collisions. */
function deriveProviderId(kind: string, existing: ProviderConfig[]): string {
  const ids = new Set(existing.map((p) => p.id));
  if (!ids.has(kind)) return kind;
  let n = 2;
  while (ids.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
}

/** Build a ProviderView from config (redact secrets). */
function toView(config: ProviderConfig, secrets: SecretStore): ProviderView {
  const { apiKey, apiKeySecret, headers, ...rest } = config;
  void apiKey;
  const safeHeaders = headers && Object.fromEntries(Object.entries(headers).map(([name, value]) =>
    [name, isSecretProviderHeader(name) ? '••••' : value],
  ));
  return {
    ...rest,
    ...(safeHeaders ? { headers: safeHeaders } : {}),
    hasApiKey: Boolean(config.apiKey || (apiKeySecret && secrets.get(apiKeySecret))),
    isLocal: config.local ?? (config.kind === 'mock' || config.kind === 'ollama' || isLocalUrl(config.baseUrl)),
  };
}

/** Check if a provider id is from the config file (not the DB). */
function isConfigProvider(services: NeoServices, id: string): boolean {
  return services.config.providers.some((p) => p.id === id);
}

export function registerProviders(app: Hono, services: NeoServices): void {
  const { providerConfigs, providers, secrets, settings } = services;

  /** Adapter construction may fail. Restore both persisted and live state. */
  function save(config: ProviderConfig, inlineKey: string | undefined, previous: ProviderConfig | null): ProviderConfig {
    // Defense-in-depth: a persisted apiKeySecret must be scoped to this provider.
    // The public schemas already omit apiKeySecret; this guards internal callers.
    if (config.apiKeySecret) {
      const scope = `provider:${config.id}`;
      if (config.apiKeySecret !== scope && !config.apiKeySecret.startsWith(`${scope}:`)) {
        throw new NeoError('bad_request', `Provider secret reference must be scoped to provider "${config.id}".`);
      }
    }
    const secretName = `provider:${config.id}`;
    const secretPrefix = `provider:${config.id}:header:`;
    const previousSecrets = new Map(secrets.list().filter((name) => name === secretName || name.startsWith(secretPrefix)).map((name) => [name, secrets.get(name)!]));
    let adapterChanged = false;
    const persist = () => {
      if (inlineKey !== undefined) {
        if (inlineKey) secrets.set(secretName, inlineKey);
        else secrets.delete(secretName);
      }
      const protectedConfig = protectProviderHeaders(config, secrets);
      providers.upsert(resolveStoredProviderHeaders(protectedConfig, secrets));
      adapterChanged = true;
      return providerConfigs.upsert(protectedConfig);
    };
    try {
      return services.db ? services.db.transaction(persist) : persist();
    } catch (error) {
      for (const name of secrets.list()) {
        if ((name === secretName || name.startsWith(secretPrefix)) && !previousSecrets.has(name)) secrets.delete(name);
      }
      for (const [name, value] of previousSecrets) secrets.set(name, value);
      // upsert builds before replacing the adapter; restore only after a successful replacement.
      if (adapterChanged) {
        if (previous) providers.upsert(resolveStoredProviderHeaders(previous, secrets));
        else providers.remove(config.id);
      }
      throw NeoError.from(error);
    }
  }

  // GET /api/providers
  app.get('/api/providers', (c) => {
    const configProviders = services.config.providers;
    const dbProviders = providerConfigs.list();
    const allConfigs: ProviderConfig[] = [...configProviders, ...dbProviders];
    const currentSettings = settings.get();
    return c.json({
      items: allConfigs.map((config) => toView(config, secrets)),
      defaultModel: currentSettings.defaultModel,
    });
  });

  // POST /api/providers
  app.post('/api/providers', async (c) => {
    const body = await validateBody(c, CreateProviderRequestSchema);
    const allConfigs = [...services.config.providers, ...providerConfigs.list()];

    // Derive id if not provided
    const id = body.id ?? deriveProviderId(body.kind, allConfigs);
    if (allConfigs.some((config) => config.id === id)) throw new NeoError('conflict', 'Provider id already exists');

    // Move apiKey into SecretStore
    const { apiKey, ...rest } = body;
    const config: ProviderConfig = { ...rest, id, ...(apiKey !== undefined ? { apiKeySecret: apiKey ? `provider:${id}` : undefined } : {}) };
    const saved = save(config, apiKey, null);
    services.refreshEmbeddingProvider?.(id);

    // Set as default model if no default exists yet
    const currentSettings = settings.get();
    if (!currentSettings.defaultModel && saved.defaultModel) {
      settings.update({ defaultModel: { provider: saved.id, model: saved.defaultModel } });
    }

    return c.json(toView(saved, secrets), 201);
  });

  // PATCH /api/providers/:id
  app.patch('/api/providers/:id', async (c) => {
    const id = c.req.param('id');

    // Config-file providers are immutable
    if (isConfigProvider(services, id)) {
      throw new NeoError('conflict', 'Config-file providers cannot be modified via the API');
    }

    const existing = providerConfigs.get(id);
    if (!existing) throw new NeoError('not_found', 'Provider not found');

    const body = await validateBody(c, UpdateProviderRequestSchema);

    // If a new apiKey is provided, move it to SecretStore
    const { apiKey, ...rest } = body;
    const patch: Partial<ProviderConfig> = { ...rest, ...(apiKey !== undefined ? { apiKey: undefined, apiKeySecret: apiKey ? `provider:${id}` : undefined } : {}) };
    const updated = save({ ...existing, ...patch }, apiKey, existing);
    services.refreshEmbeddingProvider?.(id);

    return c.json(toView(updated, secrets));
  });

  // DELETE /api/providers/:id
  app.delete('/api/providers/:id', (c) => {
    const id = c.req.param('id');

    // Config-file providers are immutable
    if (isConfigProvider(services, id)) {
      throw new NeoError('conflict', 'Config-file providers cannot be deleted via the API');
    }

    const ok = providerConfigs.delete(id);
    if (!ok) throw new NeoError('not_found', 'Provider not found');
    providers.remove(id);
    secrets.delete(`provider:${id}`);
    for (const name of secrets.list()) {
      if (name.startsWith(`provider:${id}:header:`)) secrets.delete(name);
    }
    services.refreshEmbeddingProvider?.(id);

    // Clear default model/memory model if pointing at this provider
    const currentSettings = settings.get();
    const patch: NeoSettingsPatch = {};
    if (currentSettings.defaultModel?.provider === id) patch.defaultModel = null;
    if (currentSettings.memoryModel?.provider === id) patch.memoryModel = null;
    if (Object.keys(patch).length) settings.update(patch);

    return new Response(null, { status: 204 });
  });

  // GET /api/providers/:id/models
  app.get('/api/providers/:id/models', async (c) => {
    const id = c.req.param('id');
    const adapter = providers.get(id);
    if (!adapter) throw new NeoError('not_found', 'Provider not found');
    const models = await adapter.listModels();
    return c.json({ items: models });
  });

  // POST /api/providers/:id/test
  app.post('/api/providers/:id/test', async (c) => {
    const id = c.req.param('id');
    const adapter = providers.get(id);
    if (!adapter) throw new NeoError('not_found', 'Provider not found');
    const result = await adapter.test();
    return c.json(result);
  });

  // POST /api/providers/test (draft, nothing saved)
  app.post('/api/providers/test', async (c) => {
    const body = await validateBody(c, TestProviderRequestSchema);
    // Build a temporary adapter to test
    const adapter = createProvider({
      id: 'draft',
      kind: body.kind,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      headers: body.headers,
      enabled: true,
    }, { logger: services.logger });
    const result = await adapter.test();
    return c.json(result);
  });
}
