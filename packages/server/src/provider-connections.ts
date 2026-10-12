import { NeoError, isLocalUrl, pickDefaultCapabilities } from '@neo/protocol';
import type { AiSettings, ProviderConfig, ProviderView, SecretStore } from '@neo/protocol';
import { createProvider } from '@neo/providers';
import { isSecretProviderHeader, protectProviderHeaders, resolveStoredProviderHeaders } from '@neo/storage';
import type { NeoServices } from './index.js';
import { readChatGPTCredentials } from './chatgpt-auth.js';

/** Derive an id from provider kind, avoiding collisions. */
export function deriveProviderId(kind: string, existing: ProviderConfig[]): string {
  const ids = new Set(existing.map((p) => p.id));
  if (!ids.has(kind)) return kind;
  let n = 2;
  while (ids.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
}

/** Build a ProviderView from config (redact secrets). */
export function providerView(config: ProviderConfig, secrets: SecretStore): ProviderView {
  const { apiKey, apiKeySecret, headers, ...rest } = config;
  const chatGPT = config.kind === 'chatgpt' ? readChatGPTCredentials(secrets, config.id) : undefined;
  void apiKey;
  const safeHeaders = headers && Object.fromEntries(Object.entries(headers).map(([name, value]) =>
    [name, isSecretProviderHeader(name) ? '••••' : value],
  ));
  return {
    ...rest,
    ...(safeHeaders ? { headers: safeHeaders } : {}),
    hasApiKey: Boolean(config.apiKey || (apiKeySecret && secrets.get(apiKeySecret))),
    isLocal: config.local ?? (config.kind === 'mock' || config.kind === 'ollama' || isLocalUrl(config.baseUrl)),
    ...(config.kind === 'chatgpt' ? { needsReauthorization: !chatGPT || chatGPT.needsReauthorization === true } : {}),
  };
}

/** Adapter construction may fail. Restore both persisted and live state. */
export function saveProvider(services: NeoServices, config: ProviderConfig, inlineKey: string | undefined, previous: ProviderConfig | null, ai?: AiSettings): ProviderConfig {
  const { providerConfigs, providers, secrets, settings } = services;
  if (config.kind === 'mock') throw new NeoError('bad_request', 'Mock providers are reserved for internal tests. Connect an AI provider instead.');
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
    const saved = providerConfigs.upsert(protectedConfig);
    if (ai) settings.update({ ai });
    return saved;
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

/** Validate the key and discover defaults before any credential or settings are persisted. */
export async function connectSimpleProvider(services: NeoServices, config: ProviderConfig, apiKey: string, options: { state?: string; autoIdPrefix?: string; signal?: AbortSignal } = {}): Promise<ProviderConfig> {
  try {
    const adapter = createProvider({ ...config, apiKey }, { logger: services.logger });
    const tested = await adapter.test(options.signal);
    if (options.signal?.aborted) throw new NeoError('cancelled', 'The AI connection was cancelled.');
    if (!tested.ok) throw new NeoError('provider_error', tested.error ?? 'The AI connection could not be verified.');
    const models = await adapter.listModels(options.signal);
    if (options.signal?.aborted) throw new NeoError('cancelled', 'The AI connection was cancelled.');
    // Model discovery yields to other connections, so claim the id only at commit time.
    const existing = [...services.config.providers, ...services.providerConfigs.list()];
    const id = options.autoIdPrefix ? deriveProviderId(options.autoIdPrefix, existing) : config.id;
    if (existing.some(provider => provider.id === id)) throw new NeoError('conflict', 'Provider id already exists');
    const committed = { ...config, id };
    const capabilities = pickDefaultCapabilities(committed, models);
    if (!capabilities.text) throw new NeoError('provider_error', 'This provider did not offer a text model. Choose models in Advanced.');
    const saved = saveProvider(services, { ...committed, defaultModel: capabilities.text.model, apiKeySecret: `provider:${id}` }, apiKey, null, { mode: 'simple', capabilities, search: services.settings.get().ai.search });
    services.refreshEmbeddingProvider?.(saved.id);
    services.events.publish({ type: 'provider.connected', provider: providerView(saved, services.secrets), ...(options.state ? { state: options.state } : {}) });
    return saved;
  } catch (error) {
    if (error instanceof NeoError) {
      const message = error.code === 'internal' ? 'The AI connection could not be saved.' : error.message.split(apiKey).join('••••');
      throw new NeoError(error.code, message, { retryable: error.retryable });
    }
    throw new NeoError('provider_error', 'The AI connection could not be completed. Try again.');
  }
}
