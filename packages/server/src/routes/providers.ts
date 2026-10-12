import type { Hono } from 'hono';
import { AI_CAPABILITIES, CreateProviderRequestSchema, NeoError, TestProviderRequestSchema, UpdateProviderRequestSchema } from '@neo/protocol';
import type { ProviderConfig } from '@neo/protocol';
import { createProvider } from '@neo/providers';
import type { NeoServices } from '../index.js';
import { validateBody } from './helpers.js';
import { connectSimpleProvider, deriveProviderId, providerView, saveProvider } from '../provider-connections.js';
import { settingsView } from '../search-settings.js';

/** Check if a provider id is from the config file (not the DB). */
function isConfigProvider(services: NeoServices, id: string): boolean {
  return services.config.providers.some((p) => p.id === id);
}

export function registerProviders(app: Hono, services: NeoServices): void {
  const { providerConfigs, providers, secrets, settings } = services;

  // GET /api/providers
  app.get('/api/providers', (c) => {
    const configProviders = services.config.providers;
    const dbProviders = providerConfigs.list();
    const allConfigs: ProviderConfig[] = [...configProviders, ...dbProviders].filter(provider => provider.kind !== 'mock');
    const currentSettings = settings.get();
    return c.json({
      items: allConfigs.map((config) => providerView(config, secrets)),
      defaultModel: currentSettings.defaultModel,
      ai: settingsView(currentSettings, secrets).ai,
    });
  });

  // POST /api/providers
  app.post('/api/providers', async (c) => {
    const body = await validateBody(c, CreateProviderRequestSchema);
    if (body.kind === 'mock') throw new NeoError('bad_request', 'Mock providers are reserved for internal tests. Connect an AI provider instead.');
    if (body.kind === 'chatgpt') throw new NeoError('bad_request', 'Use Sign in with ChatGPT to connect this provider.');
    const allConfigs = [...services.config.providers, ...providerConfigs.list()];

    // Derive id if not provided
    const id = body.id ?? deriveProviderId(body.kind, allConfigs);
    if (allConfigs.some((config) => config.id === id)) throw new NeoError('conflict', 'Provider id already exists');

    // Move apiKey into SecretStore
    const { apiKey, simple, ...rest } = body;
    const config: ProviderConfig = { ...rest, id, ...(apiKey !== undefined ? { apiKeySecret: apiKey ? `provider:${id}` : undefined } : {}) };
    if (simple && !apiKey?.trim()) throw new NeoError('bad_request', 'Paste an API key to connect.');
    const saved = simple
      ? await connectSimpleProvider(services, config, apiKey!, body.id ? {} : { autoIdPrefix: body.kind })
      : saveProvider(services, config, apiKey, null);
    services.refreshEmbeddingProvider?.(id);

    // Set as default model if no default exists yet
    const currentSettings = settings.get();
    if (!currentSettings.ai.capabilities.text && saved.defaultModel) {
      settings.update({ ai: { capabilities: { text: { provider: saved.id, model: saved.defaultModel } } } });
    }

    return c.json(providerView(saved, secrets), 201);
  });

  // PATCH /api/providers/:id
  app.patch('/api/providers/:id', async (c) => {
    const id = c.req.param('id');
    const body = await validateBody(c, UpdateProviderRequestSchema);
    const raw: unknown = await c.req.json();
    if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'mock') {
      throw new NeoError('bad_request', 'Mock providers are reserved for internal tests. Connect an AI provider instead.');
    }

    // Config-file providers are immutable
    if (isConfigProvider(services, id)) {
      throw new NeoError('conflict', 'Config-file providers cannot be modified via the API');
    }

    const existing = providerConfigs.get(id);
    if (!existing) throw new NeoError('not_found', 'Provider not found');
    if (existing.kind === 'mock') throw new NeoError('bad_request', 'Mock providers are reserved for internal tests. Connect an AI provider instead.');
    if (existing.kind === 'chatgpt' && Object.keys(body).some(key => key !== 'label' && key !== 'enabled')) {
      throw new NeoError('bad_request', 'ChatGPT account credentials can only be changed through sign-in.');
    }

    // If a new apiKey is provided, move it to SecretStore
    const { apiKey, ...rest } = body;
    const patch: Partial<ProviderConfig> = { ...rest, ...(apiKey !== undefined ? { apiKey: undefined, apiKeySecret: apiKey ? `provider:${id}` : undefined } : {}) };
    const updated = saveProvider(services, { ...existing, ...patch }, apiKey, existing);
    services.refreshEmbeddingProvider?.(id);

    return c.json(providerView(updated, secrets));
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
    services.cancelChatGPTSignIns?.(id);
    providers.remove(id);
    services.chatGPTTokens?.disconnect(id);
    secrets.delete(`provider:${id}`);
    for (const name of secrets.list()) {
      if (name.startsWith(`provider:${id}:header:`)) secrets.delete(name);
    }
    services.refreshEmbeddingProvider?.(id);

    const currentSettings = settings.get();
    const capabilities = { ...currentSettings.ai.capabilities };
    for (const capability of AI_CAPABILITIES) {
      if (capabilities[capability]?.provider === id) capabilities[capability] = null;
    }
    settings.update({ ai: { capabilities } });

    return new Response(null, { status: 204 });
  });

  // GET /api/providers/:id/models
  app.get('/api/providers/:id/models', async (c) => {
    const id = c.req.param('id');
    const adapter = providers.get(id);
    if (!adapter || adapter.kind === 'mock') throw new NeoError('not_found', 'Provider not found');
    const models = await adapter.listModels();
    return c.json({ items: models });
  });

  // POST /api/providers/:id/test
  app.post('/api/providers/:id/test', async (c) => {
    const id = c.req.param('id');
    const adapter = providers.get(id);
    if (!adapter || adapter.kind === 'mock') throw new NeoError('not_found', 'Provider not found');
    const result = await adapter.test();
    return c.json(result);
  });

  // POST /api/providers/test (draft, nothing saved)
  app.post('/api/providers/test', async (c) => {
    const body = await validateBody(c, TestProviderRequestSchema);
    if (body.kind === 'mock') throw new NeoError('bad_request', 'Mock providers are reserved for internal tests. Connect an AI provider instead.');
    if (body.kind === 'chatgpt') throw new NeoError('bad_request', 'Use Sign in with ChatGPT to connect this provider.');
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
