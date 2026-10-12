/**
 * Model providers ("you choose the AI"). Every adapter — Anthropic, OpenAI,
 * OpenAI-compatible servers (Ollama, LM Studio, vLLM, llama.cpp, OpenRouter,
 * Groq…), Gemini and internal test doubles — normalize to the same streaming
 * contract below, so the agent loop never knows which AI it is talking to.
 */
import { z } from 'zod';
import type { ContentPart, ProviderPart, ReasoningPart, Source, Usage } from './content.js';

export const ProviderKindSchema = z.enum(['anthropic', 'openai', 'chatgpt', 'openai-compatible', 'gemini', 'ollama', 'mock']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderConfigSchema = z.object({
  /** Stable slug, e.g. "anthropic", "ollama", "work-openai". */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  kind: ProviderKindSchema,
  label: z.string().max(100).optional(),
  baseUrl: z.string().url().optional(),
  /** Inline key (config file / env). Prefer `apiKeySecret` for keys entered in the app. */
  apiKey: z.string().optional(),
  /** Name of an encrypted secret in the SecretStore. */
  apiKeySecret: z.string().optional(),
  defaultModel: z.string().optional(),
  /** Known/allowed models; listModels() augments this when the provider supports listing. */
  models: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
  /** Force "runs on your infrastructure" (affects sensitive-memory sharing). Auto-detected from baseUrl when unset. */
  local: z.boolean().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderConfigInput = z.input<typeof ProviderConfigSchema>;

/** ProviderConfig as returned by the API: secrets are never sent to clients. */
export type ProviderView = Omit<ProviderConfig, 'apiKey' | 'apiKeySecret'> & { hasApiKey: boolean; isLocal: boolean; needsReauthorization?: boolean };

export const ModelCapabilitiesSchema = z.object({
  text: z.boolean().optional(),
  speechToText: z.boolean().optional(),
  textToSpeech: z.boolean().optional(),
  image: z.boolean().optional(),
  video: z.boolean().optional(),
  nativeWebSearch: z.boolean().optional(),
  tools: z.boolean(),
  vision: z.boolean(),
  reasoning: z.boolean(),
  embeddings: z.boolean(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  nativeWebSearch: false,
  tools: true,
  vision: false,
  reasoning: false,
  embeddings: false,
  contextWindow: 32_000,
  maxOutputTokens: 4096,
};

export interface ModelInfo {
  id: string;
  provider: string;
  label?: string | undefined;
  capabilities: ModelCapabilities;
}

/** What the model sees for each tool. `inputSchema` is JSON Schema (object). */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Provider-neutral transcript entry produced by `toChatMessages()`:
 * - user:      text | image parts (context and ui_event parts are already rendered to text)
 * - assistant: reasoning | text | tool_call parts
 * - tool:      tool_result parts (one entry holds all results of one assistant step)
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  parts: ContentPart[];
}

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export interface ChatRequest {
  model: string;
  /** Frozen per conversation by the agent runtime. */
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Forced tool choice is intentionally unsupported (several current models reject it). */
  toolChoice?: 'auto' | 'none';
  temperature?: number;
  maxTokens?: number;
  /** 'json' asks for a single JSON object (used by memory extraction/consolidation). */
  responseFormat?: 'text' | 'json';
  /** Reasoning depth hint; adapters map it to provider knobs (Anthropic effort, OpenAI reasoning_effort…). */
  reasoning?: ReasoningEffort;
  /** Provider-hosted search; set only on user-facing chat turns. */
  webSearch?: { maxUses?: number };
  signal?: AbortSignal;
  /** Free-form tags for logging/mock scripting, e.g. { purpose: 'memory-extract' }. */
  metadata?: Record<string, string>;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'cancelled' | 'error';

/**
 * Normalized stream. Adapters MUST:
 * - emit `text` / `reasoning` deltas as they arrive;
 * - accumulate partial tool-call JSON internally and emit ONE complete `tool_call` per call;
 * - emit `reasoning_part` once per finished reasoning block when it carries replay data;
 * - end with exactly one `done` (after an optional `usage`);
 * - throw NeoError (provider_error | provider_auth | rate_limited | cancelled | timeout) on failure.
 */
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'reasoning_part'; part: ReasoningPart }
  | { type: 'tool_call'; id: string; name: string; input: unknown; data?: unknown }
  | { type: 'sources'; items: Source[] }
  | { type: 'provider_part'; part: ProviderPart }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stopReason: StopReason };

export interface ChatModel {
  chat(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

export interface EmbedRequest {
  model: string;
  texts: string[];
  signal?: AbortSignal;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  models?: string[];
  error?: string;
}

export interface ProviderAdapter extends ChatModel {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly config: ProviderConfig;
  /** True when the endpoint runs on the user's own infrastructure (localhost/LAN/mock). */
  readonly isLocal: boolean;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  capabilities(model: string): ModelCapabilities;
  /** Present only when the provider offers embeddings. Returns one vector per text. */
  embed?(request: EmbedRequest): Promise<number[][]>;
  /** Cheap connectivity/auth check used by onboarding & settings. */
  test(signal?: AbortSignal): Promise<ProviderTestResult>;
}

export interface ProviderRegistry {
  get(id: string): ProviderAdapter | undefined;
  list(): ProviderAdapter[];
  /** Throws NeoError('not_found' | 'config_error') when the provider is unknown or disabled. */
  resolve(ref: { provider: string; model: string }): { adapter: ProviderAdapter; model: string };
  upsert(config: ProviderConfig): ProviderAdapter;
  remove(id: string): boolean;
}

/** Embedding function used by memory. Vectors are L2-normalized. */
export interface Embedder {
  /** Stable id stored with every vector, e.g. "hash2-512" or "openai:text-embedding-3-small". */
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

/** Result of draining a chat stream. */
export interface CollectedChat {
  text: string;
  reasoning: string;
  reasoningParts: ReasoningPart[];
  toolCalls: { id: string; name: string; input: unknown; data?: unknown }[];
  sources: Source[];
  usage: Usage | null;
  stopReason: StopReason;
}

/** Drain a stream into one result (non-streaming callers, memory extraction, tests). */
export async function collectChat(stream: AsyncIterable<ChatStreamEvent>): Promise<CollectedChat> {
  const out: CollectedChat = { text: '', reasoning: '', reasoningParts: [], toolCalls: [], sources: [], usage: null, stopReason: 'end' };
  for await (const ev of stream) {
    switch (ev.type) {
      case 'text':
        out.text += ev.text;
        break;
      case 'reasoning':
        out.reasoning += ev.text;
        break;
      case 'reasoning_part':
        out.reasoningParts.push(ev.part);
        break;
      case 'tool_call': {
        const call: CollectedChat['toolCalls'][number] = { id: ev.id, name: ev.name, input: ev.input };
        if (ev.data !== undefined) call.data = ev.data;
        out.toolCalls.push(call);
        break;
      }
      case 'usage':
        out.usage = ev.usage;
        break;
      case 'sources':
        out.sources.push(...ev.items);
        break;
      case 'done':
        out.stopReason = ev.stopReason;
        break;
    }
  }
  return out;
}

/** True for loopback, private-LAN and *.local hosts. */
export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan')) return true;
  if (host.includes(':')) {
    // IPv6 literal: loopback, unique-local (fc00::/7) and link-local (fe80::/10). Never apply these
    // prefix checks to DNS names — "fd-api.example.com" is a public host.
    return host === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

export interface ProviderPreset {
  kind: ProviderKind;
  label: string;
  description: string;
  baseUrl?: string;
  defaultModel?: string;
  /** Suggestions only; the live list comes from listModels(). */
  suggestedModels: string[];
  embeddingModel?: string;
  needsKey: boolean;
  /** Runs on the user's own device/server. */
  local: boolean;
  keyUrl?: string;
  docsUrl?: string;
}

/** Onboarding presets ("choose your AI"). Pure data so every client can show them. */
export const OPENROUTER_PRESET: ProviderPreset = {
  kind: 'openai-compatible',
  label: 'OpenRouter',
  description: 'One account for Claude, GPT, Gemini and more.',
  baseUrl: 'https://openrouter.ai/api/v1',
  suggestedModels: [],
  needsKey: true,
  local: false,
};

export const PROVIDER_PRESETS: Record<Exclude<ProviderKind, 'mock' | 'chatgpt'>, ProviderPreset> & Partial<Record<'mock' | 'chatgpt', never>> = {
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic Claude',
    description: 'Claude models via the Anthropic API.',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5-5',
    suggestedModels: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    needsKey: true,
    local: false,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    docsUrl: 'https://docs.anthropic.com',
  },
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    description: 'GPT models via the OpenAI API.',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5',
    suggestedModels: ['gpt-5', 'gpt-5-mini'],
    embeddingModel: 'text-embedding-3-small',
    needsKey: true,
    local: false,
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  gemini: {
    kind: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini models via the Google AI (Generative Language) API.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    embeddingModel: 'gemini-embedding-001',
    needsKey: true,
    local: false,
    keyUrl: 'https://aistudio.google.com/app/apikey',
  },
  ollama: {
    kind: 'ollama',
    label: 'Ollama (on your device)',
    description: 'Open models running locally with Ollama. Nothing leaves your machine.',
    baseUrl: 'http://127.0.0.1:11434',
    defaultModel: 'llama3.1',
    suggestedModels: ['llama3.1', 'qwen3', 'gemma3', 'mistral'],
    embeddingModel: 'nomic-embed-text',
    needsKey: false,
    local: true,
    docsUrl: 'https://ollama.com',
  },
  'openai-compatible': {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible server',
    description: 'LM Studio, vLLM, llama.cpp, OpenRouter, Groq, Together… any /v1/chat/completions endpoint.',
    baseUrl: 'http://127.0.0.1:1234/v1',
    suggestedModels: [],
    needsKey: false,
    local: false,
  },
};
