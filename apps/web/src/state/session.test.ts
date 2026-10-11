/**
 * F10: Conversation caches are cleared on server switch, and in-flight
 * responses from the old server are discarded after switching.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Conversation, type Note, type ProvidersResponse } from '@neo/protocol';
import { NeoClient } from '@neo/client';
import { useConversations } from './conversations.js';
import { loadNotes, loadTaskLists, refreshPendingMemories, useData } from './data.js';
import { loadConversationList, refreshAll, startEventStream } from './connection.js';
import type { EventContext } from './events.js';
import { connectWith } from '../actions/session.js';
import { useToasts } from './notifications.js';
import { useUi } from './ui.js';
import { loadModels, loadProviders, onSessionEnd, showConnect, startSession, updateSettings, useSession } from './session.js';

// ── module mocks ──────────────────────────────────────────────────────────────

// Prevent NeoClient from making real network requests.
vi.mock('@neo/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@neo/client')>();
  return {
    ...actual,
    NeoClient: vi.fn().mockImplementation(() => ({
      conversations: { list: vi.fn(), get: vi.fn() },
      notes: { list: vi.fn() },
      reminders: { list: vi.fn() },
      tasks: { list: vi.fn(), lists: vi.fn() },
      notifications: { list: vi.fn() },
      confirmations: { list: vi.fn().mockResolvedValue({ items: [] }) },
      providers: { list: vi.fn(), models: vi.fn() },
      settings: { get: vi.fn(), update: vi.fn() },
      memory: { stats: vi.fn() },
      health: vi.fn().mockResolvedValue(null),
      connect: vi.fn(() => ({ close: vi.fn(), lastSeq: 0 })),
    })),
  };
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConversation(id: string): Conversation {
  return {
    id,
    title: id,
    model: null,
    incognito: false,
    pinned: false,
    archived: false,
    createdAt: 1000,
    updatedAt: 1000,
    systemPrompt: null,
    toolset: null,
    lastMessageAt: null,
    preview: null,
  };
}

function makeNote(id: string, title: string): Note {
  return { id, title, content: '', tags: [], pinned: false, createdAt: 1000, updatedAt: 1000 };
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  useConversations.setState({ conversations: {}, entries: {}, listLoaded: false, archivedLoaded: false });
  useData.setState({
    reminders: {}, remindersLoaded: false,
    tasks: {}, taskLists: [], tasksLoaded: false,
    notes: {}, notesLoaded: false,
    memoryVersion: 0, pendingMemories: 0,
    notifications: [], unreadNotifications: 0,
  });
  useSession.setState((s) => ({ ...s, phase: 'booting' }));
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('startSession cache reset (F10)', () => {
  it('clears the conversations store when switching servers', () => {
    // Pre-populate server A data.
    useConversations.setState({
      conversations: { conv_a1: makeConversation('conv_a1') },
      entries: {},
      listLoaded: true,
      archivedLoaded: false,
    });
    useData.setState((s) => ({ ...s, notes: { note_a1: makeNote('note_a1', 'Server A note') }, notesLoaded: true }));

    // Switch to server B.
    startSession('https://server-b.example', 'tok_b', 'manual');

    const convState = useConversations.getState();
    expect(convState.conversations).toEqual({});
    expect(convState.listLoaded).toBe(false);

    const dataState = useData.getState();
    expect(dataState.notes).toEqual({});
    expect(dataState.notesLoaded).toBe(false);
  });

  it('increments sessionEpoch on every switch', () => {
    const epoch0 = useSession.getState().sessionEpoch;
    startSession('https://server-a.example', 'tok_a', 'manual');
    const epoch1 = useSession.getState().sessionEpoch;
    startSession('https://server-b.example', 'tok_b', 'manual');
    const epoch2 = useSession.getState().sessionEpoch;
    expect(epoch1).toBe(epoch0 + 1);
    expect(epoch2).toBe(epoch0 + 2);
  });

  it('A→B→A: only the most-recently loaded conversations are visible', async () => {
    // Server A session: loadConversationList returns conv_a1.
    const clientA = startSession('https://server-a.example', 'tok_a', 'manual');
    vi.mocked(clientA.conversations.list).mockResolvedValueOnce({ items: [makeConversation('conv_a1')] });
    await loadConversationList(clientA);
    expect(Object.keys(useConversations.getState().conversations)).toContain('conv_a1');

    // Switch to server B — caches cleared.
    const clientB = startSession('https://server-b.example', 'tok_b', 'manual');
    expect(useConversations.getState().conversations).toEqual({});

    vi.mocked(clientB.conversations.list).mockResolvedValueOnce({ items: [makeConversation('conv_b1')] });
    await loadConversationList(clientB);
    expect(Object.keys(useConversations.getState().conversations)).toContain('conv_b1');
    expect(Object.keys(useConversations.getState().conversations)).not.toContain('conv_a1');

    // Switch back to server A — caches cleared again.
    const clientA2 = startSession('https://server-a.example', 'tok_a', 'manual');
    expect(useConversations.getState().conversations).toEqual({});

    vi.mocked(clientA2.conversations.list).mockResolvedValueOnce({ items: [makeConversation('conv_a2')] });
    await loadConversationList(clientA2);
    expect(Object.keys(useConversations.getState().conversations)).toContain('conv_a2');
    expect(Object.keys(useConversations.getState().conversations)).not.toContain('conv_b1');
  });

  it('late response from the original A session stays discarded through A→B→A', async () => {
    // Start server A session.
    const clientA = startSession('https://server-a.example', 'tok_a', 'manual');

    // Begin a slow notes load for server A (defer the response).
    let resolveA!: (v: { items: Note[] }) => void;
    vi.mocked(clientA.notes.list).mockReturnValueOnce(new Promise((r) => { resolveA = r; }));
    const pendingLoad = loadNotes(clientA);

    // Switch to server B before the response arrives.
    startSession('https://server-b.example', 'tok_b', 'manual');
    startSession('https://server-a.example', 'tok_a', 'manual');

    // Now resolve the original server A session's response.
    resolveA({ items: [makeNote('note_a_late', 'Late note from A')] });
    await pendingLoad;

    // Server A's data must NOT appear in the store.
    expect(useData.getState().notes).toEqual({});
    expect(useData.getState().notesLoaded).toBe(false);
  });
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const providers: ProvidersResponse = { items: [], defaultModel: null };

describe('session-scoped async work', () => {
  it('resets provider/settings/model caches, drafts and server toasts', () => {
    startSession('https://a.example', 'a', 'manual');
    useSession.setState({ settings: DEFAULT_SETTINGS, providers, models: { old: [] } });
    useUi.setState({ draft: { model: { provider: 'old', model: 'old' }, incognito: true } });
    useToasts.setState({ toasts: [{ id: 'old', tone: 'reminder', title: 'Server A', duration: null, createdAt: 0 }] });
    startSession('https://b.example', 'b', 'manual');
    expect(useSession.getState()).toMatchObject({ settings: null, providers: null, models: {} });
    expect(useUi.getState().draft).toEqual({ model: null, incognito: false });
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it('discards late provider, model, pending-memory and task-list responses', async () => {
    const a = startSession('https://a.example', 'a', 'manual');
    const p = deferred<ProvidersResponse>();
    const m = deferred<{ items: [] }>();
    const stats = deferred<Awaited<ReturnType<typeof a.memory.stats>>>();
    const lists = deferred<Awaited<ReturnType<typeof a.tasks.lists>>>();
    vi.mocked(a.providers.list).mockReturnValueOnce(p.promise);
    vi.mocked(a.providers.models).mockReturnValueOnce(m.promise);
    vi.mocked(a.memory.stats).mockReturnValueOnce(stats.promise);
    vi.mocked(a.tasks.lists).mockReturnValueOnce(lists.promise);
    const loads = [loadProviders(), loadModels('old'), refreshPendingMemories(a), loadTaskLists(a)];
    startSession('https://b.example', 'b', 'manual');
    p.resolve(providers);
    m.resolve({ items: [] });
    stats.resolve({ pending: 9 } as Awaited<ReturnType<typeof a.memory.stats>>);
    lists.resolve({ items: [{ id: 'old', name: 'A', color: null, icon: null, order: 0, createdAt: 0 }] });
    await Promise.all(loads);
    expect(useSession.getState()).toMatchObject({ providers: null, models: {} });
    expect(useData.getState()).toMatchObject({ pendingMemories: 0, taskLists: [] });
  });

  it.each(['resolve', 'reject'] as const)('a stale optimistic settings %s cannot alter the new session', async (outcome) => {
    const a = startSession('https://a.example', 'a', 'manual');
    useSession.setState({ settings: DEFAULT_SETTINGS });
    const response = deferred<typeof DEFAULT_SETTINGS>();
    vi.mocked(a.settings.update).mockReturnValueOnce(response.promise);
    const update = updateSettings({ theme: 'dark' }).catch(() => undefined);
    startSession('https://b.example', 'b', 'manual');
    const settingsB = { ...DEFAULT_SETTINGS, theme: 'light' as const };
    useSession.setState({ settings: settingsB });
    if (outcome === 'resolve') response.resolve({ ...DEFAULT_SETTINGS, theme: 'dark' });
    else response.reject(new Error('old server failed'));
    await update;
    expect(useSession.getState().settings).toBe(settingsB);
  });

  it('stale reconnect settings and memory refreshes cannot repopulate the new session', async () => {
    const a = startSession('https://a.example', 'a', 'manual');
    const settings = deferred<typeof DEFAULT_SETTINGS>();
    vi.mocked(a.settings.get).mockReturnValueOnce(settings.promise);
    vi.mocked(a.conversations.list).mockResolvedValueOnce({ items: [] });
    vi.mocked(a.memory.stats).mockResolvedValueOnce({ pending: 1 } as Awaited<ReturnType<typeof a.memory.stats>>);
    const refresh = refreshAll(a, null);
    startSession('https://b.example', 'b', 'manual');
    settings.resolve(DEFAULT_SETTINGS);
    await refresh;
    expect(useSession.getState().settings).toBeNull();
    expect(useData.getState().memoryVersion).toBe(0);
  });

  it('closes the old websocket immediately and ignores queued events/status callbacks', () => {
    const a = startSession('https://a.example', 'a', 'manual');
    const context = vi.fn(() => ({} as EventContext));
    const stop = startEventStream({ client: a, context, activeConversationId: () => null });
    const callbacks = vi.mocked(a.connect).mock.calls[0]![0]!;
    const connection = vi.mocked(a.connect).mock.results[0]!.value;
    startSession('https://b.example', 'b', 'manual');
    expect(connection.close).toHaveBeenCalledTimes(1);
    callbacks.onEvent?.({ seq: 1, at: 0, event: { type: 'conversation.updated', conversation: makeConversation('late_a') } });
    callbacks.onStatus?.('open');
    expect(context).not.toHaveBeenCalled();
    expect(useConversations.getState().conversations).toEqual({});
    expect(useSession.getState().wsStatus).toBe('idle');
    useSession.setState({ wsStatus: 'open' });
    stop();
    expect(useSession.getState().wsStatus).toBe('open');
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('runs all session cleanup callbacks once and permits earlier disposal', () => {
    startSession('https://a.example', 'a', 'manual');
    const cleanup = vi.fn();
    const disposed = vi.fn();
    onSessionEnd(cleanup);
    const unregister = onSessionEnd(disposed);
    unregister();
    startSession('https://b.example', 'b', 'manual');
    showConnect({ reason: 'none' });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(disposed).not.toHaveBeenCalled();
  });

  it('a loader invoked with an old client after switching cannot cache its response', async () => {
    const a = startSession('https://a.example', 'a', 'manual');
    startSession('https://b.example', 'b', 'manual');
    vi.mocked(a.notes.list).mockResolvedValueOnce({ items: [makeNote('old', 'A')] });
    await loadNotes(a);
    expect(useData.getState().notes).toEqual({});
  });

  it('disconnect invalidates pending responses and closes the websocket', async () => {
    const a = startSession('https://a.example', 'a', 'manual');
    const response = deferred<{ items: Note[] }>();
    vi.mocked(a.notes.list).mockReturnValueOnce(response.promise);
    const load = loadNotes(a);
    startEventStream({ client: a, context: () => ({} as EventContext), activeConversationId: () => null });
    const connection = vi.mocked(a.connect).mock.results[0]!.value;
    showConnect({ reason: 'none' });
    response.resolve({ items: [makeNote('old', 'A')] });
    await load;
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(useData.getState().notes).toEqual({});
  });

  it('a stale connection bootstrap cannot mark a newer server ready', async () => {
    const response = deferred<typeof DEFAULT_SETTINGS>();
    vi.mocked(NeoClient).mockImplementationOnce(() => ({
      settings: { get: vi.fn(() => response.promise) }, health: vi.fn().mockResolvedValue(null),
    }) as unknown as NeoClient);
    const connecting = connectWith('https://a.example', 'a', 'manual');
    const b = startSession('https://b.example', 'b', 'manual');
    response.resolve(DEFAULT_SETTINGS);
    await connecting;
    expect(useSession.getState()).toMatchObject({ client: b, phase: 'booting', settings: null });
  });
});
