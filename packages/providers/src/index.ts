/**
 * @neo/providers — "you choose the AI".
 *
 * FROZEN PUBLIC API (docs/IMPLEMENTATION_PLAN.md, WP-providers). Implementations
 * may add exports but must not change these signatures.
 */
import {
  NeoError,
  type ChatRequest,
  type Logger,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderRegistry,
  type StopReason,
  type Usage,
} from '@neo/protocol';

export type { Logger };

export interface ProviderOptions {
  /** Injected for tests; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Resolves ProviderConfig.apiKeySecret names to values (encrypted SecretStore). */
  resolveSecret?: (name: string) => string | undefined;
  /** ChatGPT credentials are managed server-side and never copied into ProviderConfig. */
  getChatGPTAccessToken?: (providerId: string) => Promise<string>;
  onChatGPTUnauthorized?: (providerId: string, accessToken?: string) => void;
  logger?: Logger;
  /** Required explicit script for internal `mock` test providers. */
  mockScript?: MockScript;
  /** Waits between pre-first-byte retries (default: an abortable timer). Injected by tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** What the mock model "says" for one request. */
export interface MockReply {
  text?: string;
  reasoning?: string;
  toolCalls?: { name: string; input: unknown; id?: string }[];
  /** Delay before streaming starts. */
  delayMs?: number;
  /** Stream text in chunks of this many characters (default 12). */
  chunkSize?: number;
  /** Defaults: 'tool_use' when toolCalls are present, else 'end'. */
  stopReason?: StopReason;
  usage?: Usage;
}

/** `callIndex` counts chat() calls on this provider instance, starting at 0. */
export type MockScript = (request: ChatRequest, callIndex: number) => MockReply | Promise<MockReply>;

export interface SSEMessage {
  event?: string;
  data: string;
  id?: string;
}

// ---- Implementations ----

import { AnthropicAdapter } from './anthropic.js';
import { OpenAIAdapter } from './openai.js';
import { ChatGPTAdapter } from './chatgpt.js';
import { GeminiAdapter } from './gemini.js';
import { MockProvider } from './mock.js';
export { parseSSE } from './sse.js';
export { withRetry } from './retry.js';
export type { RetryOptions } from './retry.js';

/**
 * Build an adapter for one provider config. Throws NeoError('config_error') for unusable configs.
 * Never throws for a missing API key: that surfaces as `provider_auth` when the adapter is used,
 * and direct calls resolve `apiKeySecret` on every call so a key saved later is picked up.
 * `createProviderRegistry` snapshots available API keys when each adapter is created.
 * `adapter.config` is the very object passed in; this function never copies secrets into it.
 */
export function createProvider(config: ProviderConfig, options: ProviderOptions = {}): ProviderAdapter {
  switch (config.kind) {
    case 'anthropic':
      return new AnthropicAdapter(config, options);
    case 'chatgpt':
      return new ChatGPTAdapter(config, options);
    case 'openai':
    case 'openai-compatible':
    case 'ollama':
      return new OpenAIAdapter(config, options);
    case 'gemini':
      return new GeminiAdapter(config, options);
    case 'mock':
      return new MockProvider(config, options);
    default: {
      const kind: never = config.kind;
      throw new NeoError('config_error', `Unknown provider kind: ${String(kind)}`);
    }
  }
}

/** Registry over many providers; disabled providers are kept (and listed) but `resolve()` refuses them. */
export function createProviderRegistry(configs: readonly ProviderConfig[], options: ProviderOptions = {}): ProviderRegistry {
  /** Snapshot the API key so a retained adapter does not re-read the secret store. */
  function snap(config: ProviderConfig): ProviderConfig {
    if (!config.apiKeySecret || !options.resolveSecret) return config;
    const key = options.resolveSecret(config.apiKeySecret);
    if (!key) return config;
    return { ...config, apiKey: key, apiKeySecret: undefined };
  }

  const adapters = new Map<string, ProviderAdapter>();
  for (const cfg of configs) adapters.set(cfg.id, createProvider(snap(cfg), options));

  return {
    get: (id) => adapters.get(id),
    list: () => [...adapters.values()],
    resolve(ref) {
      const adapter = adapters.get(ref.provider);
      if (!adapter) throw new NeoError('not_found', `Provider "${ref.provider}" not found.`);
      if (adapter.config.enabled === false) {
        throw new NeoError('config_error', `Provider "${adapter.config.label ?? ref.provider}" is disabled. Enable it in Settings → Providers.`);
      }
      return { adapter, model: ref.model };
    },
    upsert(config) {
      // Build first: a config that cannot be turned into an adapter leaves the registry unchanged.
      const adapter = createProvider(snap(config), options);
      adapters.set(config.id, adapter);
      return adapter;
    },
    remove: (id) => adapters.delete(id),
  };
}

// Re-export adapters for advanced usage
export { AnthropicAdapter } from './anthropic.js';
export { OpenAIAdapter, supportsOpenAIWebSearch } from './openai.js';
export { ChatGPTAdapter } from './chatgpt.js';
export { GeminiAdapter } from './gemini.js';
export { MockProvider } from './mock.js';
