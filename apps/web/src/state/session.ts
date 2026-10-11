/**
 * Session: which server we talk to, the API client, server health, settings,
 * the provider list (for model pickers) and the live WebSocket status.
 */
import { create } from 'zustand';
import { deepMerge, type HealthResponse, type ModelInfo, type NeoSettings, type NeoSettingsPatch, type ProvidersResponse } from '@neo/protocol';
import { NeoClient, type ConnectionStatus } from '@neo/client';
import type { ConnectionSource } from '../connection.js';
import { STORAGE_KEYS, writeString } from '../lib/storage.js';

export type Phase = 'booting' | 'connect' | 'offline' | 'ready';

export interface ConnectHint {
  reason: 'none' | 'unauthorized' | 'pair-failed' | 'same-origin' | 'manual';
  serverUrl?: string;
  token?: string;
}

export interface SessionState {
  phase: Phase;
  connectHint: ConnectHint | null;
  client: NeoClient | null;
  serverUrl: string | null;
  source: ConnectionSource | null;
  health: HealthResponse | null;
  settings: NeoSettings | null;
  wsStatus: ConnectionStatus | 'idle';
  providers: ProvidersResponse | null;
  /** Model lists per provider id (loaded lazily). */
  models: Record<string, ModelInfo[]>;
}

export const useSession = create<SessionState>(() => ({
  phase: 'booting',
  connectHint: null,
  client: null,
  serverUrl: null,
  source: null,
  health: null,
  settings: null,
  wsStatus: 'idle',
  providers: null,
  models: {},
}));

/** The client, for code that only runs once connected. */
export function requireClient(): NeoClient {
  const client = useSession.getState().client;
  if (!client) throw new Error('Not connected');
  return client;
}

export function startSession(serverUrl: string, token: string, source: ConnectionSource): NeoClient {
  const client = new NeoClient({ baseUrl: serverUrl, token });
  useSession.setState({ client, serverUrl, source, phase: 'booting', connectHint: null });
  return client;
}

export function showConnect(hint: ConnectHint): void {
  useSession.setState({ phase: 'connect', connectHint: hint, client: null, settings: null, health: null, wsStatus: 'idle', providers: null, models: {} });
}

export function setSettings(settings: NeoSettings): void {
  useSession.setState({ settings });
  // Cache what the next cold start needs before the server answers.
  writeString(STORAGE_KEYS.theme, settings.theme);
  writeString(STORAGE_KEYS.locale, settings.locale);
}

/**
 * Optimistic settings update: apply locally, send the deep-partial patch, then
 * take the server's merged result. Reverts and rethrows on failure.
 */
export async function updateSettings(patch: NeoSettingsPatch): Promise<NeoSettings> {
  const { client, settings } = useSession.getState();
  if (!client || !settings) throw new Error('Not connected');
  setSettings(deepMerge(settings, patch));
  try {
    const next = await client.settings.update(patch);
    setSettings(next);
    return next;
  } catch (err) {
    setSettings(settings);
    throw err;
  }
}

export async function loadProviders(): Promise<ProvidersResponse | null> {
  const client = useSession.getState().client;
  if (!client) return null;
  const providers = await client.providers.list();
  useSession.setState({ providers });
  return providers;
}

/** Models for a provider (cached; falls back to its configured models). */
export async function loadModels(providerId: string, force = false): Promise<ModelInfo[]> {
  const { client, models, providers } = useSession.getState();
  if (!client) return [];
  if (!force && models[providerId]) return models[providerId]!;
  let list: ModelInfo[];
  try {
    list = (await client.providers.models(providerId)).items;
  } catch {
    const p = providers?.items.find((x) => x.id === providerId);
    const ids = [...new Set([...(p?.defaultModel ? [p.defaultModel] : []), ...(p?.models ?? [])])];
    list = ids.map((id) => ({ id, provider: providerId, capabilities: { tools: true, vision: false, reasoning: false, embeddings: false, contextWindow: 32_000, maxOutputTokens: 4096 } }));
  }
  useSession.setState((s) => ({ models: { ...s.models, [providerId]: list } }));
  return list;
}
