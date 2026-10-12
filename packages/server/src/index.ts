/**
 * @neo/server — composition root + HTTP/WebSocket API.
 *
 * FROZEN PUBLIC API (docs/IMPLEMENTATION_PLAN.md, WP-server). Implementations
 * may add exports but must not change these signatures.
 */
import type { Server } from 'node:http';
import type { Hono } from 'hono';
import {
  type AgentRuntimeApi,
  type Clock,
  type ConversationStore,
  type DeepPartial,
  type DeviceStore,
  type Logger,
  type MemoryService,
  type NeoConfig,
  type Notification,
  type ProductivityStores,
  type ProviderRegistry,
  type ProviderConfig,
  type PushSubscriptionStore,
  type ReminderScheduler,
  type SecretStore,
  type SettingsStore,
  type ToolRegistry,
} from '@neo/protocol';
import type { NeoDatabase, ProviderConfigStore } from '@neo/storage';
import type { MockScript } from '@neo/providers';
import type { ChatGPTAuthOptions, ChatGPTTokenManager } from './chatgpt-auth.js';

// ── Re-export implementations ────────────────────────────────────────────────
export { loadConfig } from './config.js';
export type { NeoConfigWithPushHosts } from './config.js';
export { EventHub } from './events.js';
export { createServices } from './services.js';
export { createApp } from './app.js';
export { startServer } from './server.js';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface LoadConfigOptions {
  /** Config file (JSON). Default: $NEO_CONFIG, else <dataDir>/config.json when it exists. */
  path?: string;
  /** Defaults to process.env. Reads NEO_MODE, NEO_DATA_DIR, NEO_HOST, NEO_PORT, NEO_TOKEN,
   *  NEO_PUBLIC_URL, NEO_WEB_DIR, NEO_TRUST_PROXY, NEO_LOG_LEVEL,
   *  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OLLAMA_BASE_URL
   *  (each adds/updates a provider). */
  env?: Record<string, string | undefined>;
  /** Highest precedence (CLI flags). */
  overrides?: DeepPartial<NeoConfig>;
}

/** Delivers notifications: stores them, publishes to sockets, sends Web Push. */
export interface Notifier {
  notify(notification: import('@neo/protocol').NotificationInput): Promise<import('@neo/protocol').Notification>;
}

export interface OpenRouterOptions {
  /** Injectable auth/model API origin; production defaults to OpenRouter. */
  baseUrl?: string;
  authorizationUrl?: string;
}

export interface NeoServices {
  config: NeoConfig;
  openRouter?: OpenRouterOptions;
  chatGPT?: ChatGPTAuthOptions;
  chatGPTTokens?: ChatGPTTokenManager;
  /** Invalidate pending callbacks when a connection is explicitly removed. */
  cancelChatGPTSignIns?(providerId: string): void;
  logger: Logger;
  clock: Clock;
  /** Owner token (from config or generated into <dataDir>/token on first boot). */
  ownerToken: string;
  db: NeoDatabase | null;
  conversations: ConversationStore;
  settings: SettingsStore;
  secrets: SecretStore;
  devices: DeviceStore;
  push: PushSubscriptionStore;
  providerConfigs: ProviderConfigStore;
  providers: ProviderRegistry;
  /** Rebuild the selected memory embedder after a provider change is committed. */
  refreshEmbeddingProvider?(providerId: string): void;
  memory: MemoryService;
  tools: ToolRegistry;
  stores: ProductivityStores;
  scheduler: ReminderScheduler;
  runtime: AgentRuntimeApi;
  events: import('./events.js').EventHub;
  notifier: Notifier;
  /** Stops timers and closes the database. */
  close(): Promise<void>;
}

export interface CreateServicesOptions {
  openRouter?: OpenRouterOptions;
  /** Injectable loopback fakes for ChatGPT OAuth and model tests. */
  chatGPT?: ChatGPTAuthOptions;
  logger?: Logger;
  clock?: Clock;
  /** Internal test providers, never read from user config or persisted settings. */
  mockProviders?: ProviderConfig[];
  /** Explicit script required for internal mock providers. */
  mockScript?: MockScript;
  /** Use an in-memory database (tests). */
  inMemory?: boolean;
}

export interface NeoApp {
  app: Hono;
  /** Attach the /api/ws WebSocket handler to the Node HTTP server returned by @hono/node-server. */
  injectWebSocket(server: Server): void;
}

export interface NeoServer {
  /** e.g. http://127.0.0.1:7777 */
  url: string;
  port: number;
  ownerToken: string;
  services: NeoServices;
  stop(): Promise<void>;
}
