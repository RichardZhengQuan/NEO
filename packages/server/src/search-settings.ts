import { NeoError, SearchEngineSchema, deepMerge, type NeoConfig, type NeoSettings, type NeoSettingsPatch, type SecretStore } from '@neo/protocol';
import type { WebSearchConfig } from '@neo/tools';

const SEARCH_SECRET = 'search:engine';

/** Only a scoped server-owned reference may supply an engine credential. */
export function resolveSearchEngine(settings: NeoSettings, boot: NeoConfig['webSearch'], secrets: SecretStore): WebSearchConfig | undefined {
  const engine = settings.ai.search.engine;
  if (!engine) {
    if (boot.provider === 'none' || ((boot.provider === 'brave' || boot.provider === 'tavily') && !boot.apiKey?.trim())) return undefined;
    return boot;
  }
  const apiKey = engine.apiKeySecret === SEARCH_SECRET ? secrets.get(SEARCH_SECRET) : undefined;
  if (engine.provider !== 'searxng' && !apiKey) return undefined;
  return { provider: engine.provider, ...(engine.baseUrl ? { baseUrl: engine.baseUrl } : {}), ...(apiKey ? { apiKey } : {}) };
}

export function settingsView(settings: NeoSettings, secrets: SecretStore): NeoSettings {
  const engine = settings.ai.search.engine;
  if (!engine) return settings;
  const { apiKeySecret, ...visible } = engine;
  return {
    ...settings,
    ai: { ...settings.ai, search: { ...settings.ai.search, engine: {
      ...visible, hasApiKey: apiKeySecret === SEARCH_SECRET && !!secrets.get(SEARCH_SECRET),
    } } },
  };
}

/** Validate before saving any secret; omitted keys survive only on the same endpoint. */
export function prepareSearchPatch(settings: NeoSettings, input: NeoSettingsPatch, secrets: SecretStore): { patch: NeoSettingsPatch; commit: () => void } {
  const raw = input.ai?.search?.engine;
  if (raw === undefined) return { patch: input, commit: () => {} };
  if (raw === null) return { patch: input, commit: () => { secrets.delete(SEARCH_SECRET); } };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new NeoError('bad_request', 'Invalid search engine settings.');
  if ('apiKeySecret' in raw) throw new NeoError('bad_request', 'Search credential references are managed by the server.');
  const { apiKey, hasApiKey: _hasApiKey, ...fields } = raw;
  if (apiKey !== undefined && apiKey !== null && typeof apiKey !== 'string') throw new NeoError('bad_request', 'The search API key must be text.');
  if (typeof apiKey === 'string' && apiKey.length > 10_000) throw new NeoError('bad_request', 'The search API key is too long.');
  const previous = settings.ai.search.engine;
  const base = fields.provider === undefined || fields.provider === previous?.provider ? previous ?? {} : {};
  const merged = SearchEngineSchema.parse(deepMerge(base, fields));
  const sameEndpoint = previous?.provider === merged.provider && previous.baseUrl === merged.baseUrl;
  const key = apiKey === undefined ? (sameEndpoint && previous?.apiKeySecret === SEARCH_SECRET ? secrets.get(SEARCH_SECRET) : undefined) : apiKey?.trim() || undefined;
  const engine = { ...merged, apiKeySecret: key ? SEARCH_SECRET : null, hasApiKey: !!key };
  return {
    patch: { ...input, ai: { ...input.ai, search: { ...input.ai?.search, engine } } },
    commit: () => { if (key) secrets.set(SEARCH_SECRET, key); else secrets.delete(SEARCH_SECRET); },
  };
}
