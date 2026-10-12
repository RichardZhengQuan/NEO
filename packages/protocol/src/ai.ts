/** Capability assignments and connection defaults shared by every client. */
import { z } from 'zod';
import { ModelRefSchema, type ModelRef } from './content.js';
import type { ModelInfo, ProviderConfig } from './providers.js';

export const AI_CAPABILITIES = ['text', 'embedding', 'speechToText', 'textToSpeech', 'image', 'video'] as const;
export type AiCapability = typeof AI_CAPABILITIES[number];

export const AiCapabilitiesSchema = z.object({
  text: ModelRefSchema.nullable().default(null),
  embedding: ModelRefSchema.nullable().default(null),
  speechToText: ModelRefSchema.nullable().default(null),
  textToSpeech: ModelRefSchema.nullable().default(null),
  image: ModelRefSchema.nullable().default(null),
  video: ModelRefSchema.nullable().default(null),
});
export type AiCapabilities = z.infer<typeof AiCapabilitiesSchema>;

export const SearchEngineSchema = z.object({
  provider: z.enum(['searxng', 'brave', 'tavily']),
  baseUrl: z.string().url().optional(),
  /** Server-owned encrypted secret reference; never exposed to clients. */
  apiKeySecret: z.string().nullable().optional(),
  hasApiKey: z.boolean().optional(),
});
export type SearchEngine = z.infer<typeof SearchEngineSchema>;

export const AiSearchSchema = z.object({
  mode: z.enum(['auto', 'engine', 'off']).default('auto'),
  /** null uses the boot config's default engine, when configured. */
  engine: SearchEngineSchema.nullable().default(null),
});
export type AiSearch = z.infer<typeof AiSearchSchema>;

export function resolveSearchMode(search: AiSearch, nativeWebSearch: boolean, hasEngine: boolean): 'native' | 'engine' | 'off' {
  if (search.mode === 'off') return 'off';
  if (search.mode === 'auto' && nativeWebSearch) return 'native';
  return hasEngine ? 'engine' : 'off';
}

export const AiSettingsSchema = z.object({
  mode: z.enum(['simple', 'advanced']).default('simple'),
  capabilities: AiCapabilitiesSchema.prefault({}),
  search: AiSearchSchema.prefault({}),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

export type DetectedApiKeyProvider = 'anthropic' | 'openrouter' | 'gemini' | 'openai' | 'unknown';

/** More specific prefixes must precede the shared OpenAI prefix. */
export function detectApiKeyProvider(key: string): DetectedApiKeyProvider {
  const value = key.trim();
  if (value.startsWith('sk-ant-')) return 'anthropic';
  if (value.startsWith('sk-or-')) return 'openrouter';
  if (value.startsWith('AIza')) return 'gemini';
  if (value.startsWith('sk-proj-') || value.startsWith('sk-svcacct-') || value.startsWith('sk-')) return 'openai';
  return 'unknown';
}

/** Missing modality metadata on older compatible servers retains their text support. */
export function modelSupportsCapability(model: ModelInfo, capability: AiCapability): boolean {
  const caps = model.capabilities;
  if (capability === 'embedding') return caps.embeddings;
  if (capability !== 'text') return caps[capability] === true;
  return caps.text ?? (!(caps.embeddings && !caps.tools) && !caps.speechToText && !caps.textToSpeech && !caps.image && !caps.video);
}

/** Preferences are used only when offered by the provider's live model list. */
export const DEFAULT_AI_MODELS = {
  anthropic: { text: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-5-5'] },
  openai: { text: ['gpt-5', 'gpt-4.1', 'gpt-4o'], embedding: ['text-embedding-3-small', 'text-embedding-3-large'] },
  chatgpt: { text: ['gpt-5', 'gpt-4.1', 'gpt-4o'] },
  gemini: { text: ['gemini-2.5-pro', 'gemini-2.5-flash'], embedding: ['gemini-embedding-001', 'text-embedding-004'] },
  openrouter: { text: ['anthropic/claude-sonnet-5-5', 'openai/gpt-5', 'google/gemini-2.5-pro'] },
  custom: { text: [] },
} as const;

function newest(models: ModelInfo[]): ModelInfo | undefined {
  return [...models].sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }))[0];
}

function preferredText(provider: Pick<ProviderConfig, 'id' | 'kind' | 'baseUrl'>, models: ModelInfo[]): ModelInfo | undefined {
  const isRouter = provider.kind === 'openai-compatible' && (
    /^https:\/\/openrouter\.ai\/api\/v1\/?$/.test(provider.baseUrl ?? '') || /^openrouter(?:-\d+)?$/.test(provider.id)
  );
  const kind = isRouter ? 'openrouter' : provider.kind;
  const preferences = kind in DEFAULT_AI_MODELS ? DEFAULT_AI_MODELS[kind as keyof typeof DEFAULT_AI_MODELS].text : [];
  // Claude's balanced Sonnet default is intentional even when Opus is available.
  if (kind === 'anthropic' || kind === 'openrouter') {
    const preferred = preferences.map(id => models.find(m => m.id === id)).find(Boolean);
    if (preferred) return preferred;
  }
  if (kind === 'openai' || kind === 'chatgpt') {
    const general = models.filter(m => /^gpt-\d+(?:\.\d+)?(?:-\d{4}-\d{2}-\d{2})?$/.test(m.id));
    if (general.length) return newest(general);
  }
  if (kind === 'gemini') {
    const general = models.filter(m => /^gemini-\d+(?:\.\d+)?-(?:pro|flash)(?:-preview(?:-\d+)?)?$/.test(m.id));
    if (general.length) return newest(general);
  }
  return preferences.map(id => models.find(m => m.id === id)).find(Boolean) ?? newest(models);
}

export function pickDefaultCapabilities(
  provider: Pick<ProviderConfig, 'id' | 'kind' | 'baseUrl'>,
  models: ModelInfo[],
): AiCapabilities {
  const assignments = AiCapabilitiesSchema.parse({});
  for (const capability of AI_CAPABILITIES) {
    // ChatGPT plan tokens authorize text only, regardless of model metadata.
    if (provider.kind === 'chatgpt' && capability !== 'text') continue;
    const candidates = models.filter(m => modelSupportsCapability(m, capability));
    let chosen = capability === 'text' ? preferredText(provider, candidates) : newest(candidates);
    if (capability === 'embedding') {
      const preferences = provider.kind === 'openai' ? DEFAULT_AI_MODELS.openai.embedding
        : provider.kind === 'gemini' ? DEFAULT_AI_MODELS.gemini.embedding : [];
      chosen = preferences.map(id => candidates.find(m => m.id === id)).find(Boolean) ?? chosen;
    }
    assignments[capability] = chosen ? { provider: provider.id, model: chosen.id } satisfies ModelRef : null;
  }
  return assignments;
}
