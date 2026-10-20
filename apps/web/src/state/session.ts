/**
 * Session: which server we talk to, the API client, server health, settings,
 * the provider list (for model pickers) and the live WebSocket status.
 */
import { create } from 'zustand';
import { applySettingsPatch, type HealthResponse, type ModelInfo, type NeoSettings, type NeoSettingsPatch, type ProvidersResponse } from '@neo/protocol';
import type { NeoClient, ConnectionStatus } from '@neo/client';
import { createServerClient, type ConnectionSource, type Credentials } from '../connection.js';
import { STORAGE_KEYS, writeString } from '../lib/storage.js';
import { resetTimeline } from './timeline.js';
import { useData } from './data.js';
import { useToasts } from './notifications.js';
import { setDrawer } from './ui.js';
import { resetChatDrafts } from './chat-drafts.js';

export type Phase = 'booting' | 'connect' | 'offline' | 'ready';

export interface ConnectHint {
  reason: 'none' | 'unauthorized' | 'pair-failed' | 'same-origin' | 'manual';
  serverUrl?: string;
  token?: string;
  tunnel?: Credentials['tunnel'];
}

export interface SessionState {
  phase: Phase;
  connectHint: ConnectHint | null;
  client: NeoClient | null;
  serverUrl: string | null;
  credentials: Credentials | null;
  source: ConnectionSource | null;
  health: HealthResponse | null;
  settings: NeoSettings | null;
  wsStatus: ConnectionStatus | 'idle';
  providers: ProvidersResponse | null;
  /** Model lists per provider id (loaded lazily). */
  models: Record<string, ModelInfo[]>;
  /**
   * Incremented each time we switch servers. Lets async operations that
   * captured the epoch before a switch detect that their response is stale.
   */
  sessionEpoch: number;
}

export const useSession = create<SessionState>(() => ({
  phase: 'booting',
  connectHint: null,
  client: null,
  serverUrl: null,
  credentials: null,
  source: null,
  health: null,
  settings: null,
  wsStatus: 'idle',
  providers: null,
  models: {},
  sessionEpoch: 0,
}));

/**
 * Returns true when the given epoch (captured before an async operation)
 * still matches the current session. Use to discard in-flight responses from a
 * server the user has already switched away from.
 */
export function isCurrentSession(epoch: number, client?: NeoClient): boolean {
  const session = useSession.getState();
  return session.sessionEpoch === epoch && (client === undefined || session.client === client);
}

/** Returns the current session epoch to pass into async operations. */
export function currentSessionEpoch(): number {
  return useSession.getState().sessionEpoch;
}

/** The client, for code that only runs once connected. */
export function requireClient(): NeoClient {
  const client = useSession.getState().client;
  if (!client) throw new Error('Not connected');
  return client;
}

const sessionCleanups = new Set<() => void>();

/** Close live subscriptions synchronously when their session ends. */
export function onSessionEnd(cleanup: () => void): () => void {
  sessionCleanups.add(cleanup);
  return () => { sessionCleanups.delete(cleanup); };
}

function resetSessionData(): void {
  for (const cleanup of [...sessionCleanups]) cleanup();
  sessionCleanups.clear();
  resetChatDrafts();
  resetTimeline();
  useData.setState({
    reminders: {}, reminderDeletions: {}, remindersLoaded: false, remindersComplete: false,
    tasks: {}, taskLists: [], tasksLoaded: false,
    notes: {}, notesLoaded: false,
    memoryVersion: 0,
    notifications: [], unreadNotifications: 0,
  });
  useToasts.setState({ toasts: [] });
  setDrawer(false);
}

export function startSession(credentials: Credentials, source: ConnectionSource): NeoClient {
  const client = createServerClient(credentials);
  resetSessionData();
  resetTimeline(credentials.serverUrl);
  useSession.setState((s) => ({
    client,
    serverUrl: credentials.serverUrl,
    credentials,
    source,
    phase: 'booting',
    connectHint: null,
    health: null,
    settings: null,
    wsStatus: 'idle',
    providers: null,
    models: {},
    sessionEpoch: s.sessionEpoch + 1,
  }));
  return client;
}

export function showConnect(hint: ConnectHint): void {
  resetSessionData();
  useSession.setState((s) => ({ phase: 'connect', connectHint: hint, client: null, credentials: null, settings: null, health: null, wsStatus: 'idle', providers: null, models: {}, sessionEpoch: s.sessionEpoch + 1 }));
}

export function setSettings(settings: NeoSettings): void {
  useSession.setState({ settings });
  // Cache what the next cold start needs before the server answers.
  writeString(STORAGE_KEYS.theme, settings.theme);
  writeString(STORAGE_KEYS.locale, settings.locale);
}

/**
 * Build a revert patch that mirrors the nested structure of `patchObj`, replacing
 * each leaf with the corresponding pre-update value from `oldObj`. This ensures
 * that concurrent successful saves to sibling nested paths (e.g. memory.recallLimit
 * while another call fails on memory.recall) survive the rollback.
 */
function buildRevertPatch(
  patchObj: Record<string, unknown>,
  oldObj: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patchObj).map(([k, patchVal]) => {
      const oldVal = oldObj[k];
      if (
        patchVal !== null && typeof patchVal === 'object' && !Array.isArray(patchVal) &&
        oldVal !== null && typeof oldVal === 'object' && !Array.isArray(oldVal)
      ) {
        return [k, buildRevertPatch(
          patchVal as Record<string, unknown>,
          oldVal as Record<string, unknown>,
        )];
      }
      return [k, oldVal];
    }),
  );
}

/**
 * Optimistic settings update: apply locally, send the deep-partial patch, then
 * take the server's merged result. Reverts and rethrows on failure.
 */
export async function updateSettings(patch: NeoSettingsPatch): Promise<NeoSettings> {
  const { client, settings, sessionEpoch } = useSession.getState();
  if (!client || !settings) throw new Error('Not connected');
  setSettings(applySettingsPatch(settings, patch));
  try {
    const next = await client.settings.update(patch);
    if (isCurrentSession(sessionEpoch, client)) setSettings(next);
    return next;
  } catch (err) {
    if (isCurrentSession(sessionEpoch, client)) {
      // Revert only the exact fields this call wrote, not the entire snapshot.
      // buildRevertPatch mirrors the nested patch structure so that concurrent
      // successful saves to sibling paths (e.g. memory.recallLimit) are preserved.
      const current = useSession.getState().settings;
      if (current) {
        const revertPatch = buildRevertPatch(
          patch as Record<string, unknown>,
          settings as Record<string, unknown>,
        ) as NeoSettingsPatch;
        setSettings(applySettingsPatch(current, revertPatch));
      }
    }
    throw err;
  }
}

export async function loadProviders(): Promise<ProvidersResponse | null> {
  const { client, sessionEpoch } = useSession.getState();
  if (!client) return null;
  const providers = await client.providers.list();
  if (!isCurrentSession(sessionEpoch, client)) return null;
  useSession.setState({ providers });
  return providers;
}

/** Models for a provider (cached; falls back to its configured models). */
export async function loadModels(providerId: string, force = false): Promise<ModelInfo[]> {
  const { client, models, providers, sessionEpoch } = useSession.getState();
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
  if (!isCurrentSession(sessionEpoch, client)) return [];
  useSession.setState((s) => ({ models: { ...s.models, [providerId]: list } }));
  return list;
}
