/**
 * F10: Timeline caches are cleared on server switch, and in-flight
 * responses from the old server are discarded after switching.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Episode, type Note, type ProvidersResponse } from '@neo/protocol';
import { NeoClient } from '@neo/client';
import { applyTimelineEvent, beginTimelineStream, emptyEntry, useTimeline } from './timeline.js';
import { loadNotes, loadTaskLists, useData } from './data.js';
import { loadOffRecord, loadTimeline, refreshAll, startEventStream } from './connection.js';
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
      timeline: { offRecord: vi.fn().mockResolvedValue({ active: false, episodeId: null, startedAt: null }), startOffRecord: vi.fn().mockResolvedValue({ active: true, episodeId: null, startedAt: 1 }), list: vi.fn() },
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

function makeEpisode(id: string): Episode {
  return { id, kind: 'episode', offRecord: false, ephemeral: false, startedAt: 1000, closedAt: null, lastMessageAt: null };
}

function makeNote(id: string, title: string): Note {
  return { id, title, content: '', tags: [], pinned: false, createdAt: 1000, updatedAt: 1000 };
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  useTimeline.setState(emptyEntry(), true);
  sessionStorage.clear();
  useData.setState({
    reminders: {}, remindersLoaded: false,
    tasks: {}, taskLists: [], tasksLoaded: false,
    notes: {}, notesLoaded: false,
    memoryVersion: 0,
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
  it('clears the timeline store when switching servers', () => {
    // Pre-populate server A data.
    useTimeline.setState({
      episodes: { conv_a1: { ...makeEpisode('conv_a1'), episodeId: 'conv_a1' } },
      loaded: true,
    });
    useData.setState((s) => ({ ...s, notes: { note_a1: makeNote('note_a1', 'Server A note') }, notesLoaded: true }));

    // Switch to server B.
    startSession('https://server-b.example', 'tok_b', 'manual');

    const convState = useTimeline.getState();
    expect(convState.episodes).toEqual({});
    expect(convState.loaded).toBe(false);

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

  it('A→B→A: only the most-recently loaded timeline messages are visible', async () => {
    // Server A session: loadTimeline returns conv_a1.
    const clientA = startSession('https://server-a.example', 'tok_a', 'manual');
    vi.mocked(clientA.timeline.list).mockResolvedValueOnce({ items: [{ id: 'conv_a1', episodeId: 'ep', conversationId: 'ep', role: 'user', parts: [], createdAt: 1, status: 'complete' }], episodes: [], nextCursor: null });
    await loadTimeline(clientA);
    expect(useTimeline.getState().messages[0]?.id).toBe('conv_a1');

    // Switch to server B — caches cleared.
    const clientB = startSession('https://server-b.example', 'tok_b', 'manual');
    expect(useTimeline.getState().episodes).toEqual({});

    vi.mocked(clientB.timeline.list).mockResolvedValueOnce({ items: [{ id: 'conv_b1', episodeId: 'ep', conversationId: 'ep', role: 'user', parts: [], createdAt: 1, status: 'complete' }], episodes: [], nextCursor: null });
    await loadTimeline(clientB);
    expect(useTimeline.getState().messages[0]?.id).toBe('conv_b1');
    expect(Object.keys(useTimeline.getState().episodes)).not.toContain('conv_a1');

    // Switch back to server A — caches cleared again.
    const clientA2 = startSession('https://server-a.example', 'tok_a', 'manual');
    expect(useTimeline.getState().episodes).toEqual({});

    vi.mocked(clientA2.timeline.list).mockResolvedValueOnce({ items: [{ id: 'conv_a2', episodeId: 'ep', conversationId: 'ep', role: 'user', parts: [], createdAt: 1, status: 'complete' }], episodes: [], nextCursor: null });
    await loadTimeline(clientA2);
    expect(useTimeline.getState().messages[0]?.id).toBe('conv_a2');
    expect(Object.keys(useTimeline.getState().episodes)).not.toContain('conv_b1');
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
  it('resets provider/settings/model caches, drawer and server toasts', () => {
    startSession('https://a.example', 'a', 'manual');
    useSession.setState({ settings: DEFAULT_SETTINGS, providers, models: { old: [] } });
    useUi.setState({ drawerOpen: true });
    useToasts.setState({ toasts: [{ id: 'old', tone: 'reminder', title: 'Server A', duration: null, createdAt: 0 }] });
    startSession('https://b.example', 'b', 'manual');
    expect(useSession.getState()).toMatchObject({ settings: null, providers: null, models: {} });
    expect(useUi.getState().drawerOpen).toBe(false);
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it('discards late provider, model and task-list responses', async () => {
    const a = startSession('https://a.example', 'a', 'manual');
    const p = deferred<ProvidersResponse>();
    const m = deferred<{ items: [] }>();
    const lists = deferred<Awaited<ReturnType<typeof a.tasks.lists>>>();
    vi.mocked(a.providers.list).mockReturnValueOnce(p.promise);
    vi.mocked(a.providers.models).mockReturnValueOnce(m.promise);
    vi.mocked(a.tasks.lists).mockReturnValueOnce(lists.promise);
    const loads = [loadProviders(), loadModels('old'), loadTaskLists(a)];
    startSession('https://b.example', 'b', 'manual');
    p.resolve(providers);
    m.resolve({ items: [] });
    lists.resolve({ items: [{ id: 'old', name: 'A', color: null, icon: null, order: 0, createdAt: 0 }] });
    await Promise.all(loads);
    expect(useSession.getState()).toMatchObject({ providers: null, models: {} });
    expect(useData.getState()).toMatchObject({ taskLists: [] });
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
    vi.mocked(a.timeline.list).mockResolvedValueOnce({ items: [], episodes: [], nextCursor: null });
    const refresh = refreshAll(a);
    startSession('https://b.example', 'b', 'manual');
    settings.resolve(DEFAULT_SETTINGS);
    await refresh;
    expect(useSession.getState().settings).toBeNull();
    expect(useData.getState().memoryVersion).toBe(0);
  });

  it('closes the old websocket immediately and ignores queued events/status callbacks', () => {
    const a = startSession('https://a.example', 'a', 'manual');
    const context = vi.fn(() => ({} as EventContext));
    const stop = startEventStream({ client: a, context, timelineActive: () => false });
    const callbacks = vi.mocked(a.connect).mock.calls[0]![0]!;
    const connection = vi.mocked(a.connect).mock.results[0]!.value;
    startSession('https://b.example', 'b', 'manual');
    expect(connection.close).toHaveBeenCalledTimes(1);
    callbacks.onEvent?.({ seq: 1, at: 0, event: { type: 'conversation.updated', episodeId: 'late_a', conversation: makeEpisode('late_a') } });
    callbacks.onStatus?.('open');
    expect(context).not.toHaveBeenCalled();
    expect(useTimeline.getState().episodes).toEqual({});
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
    startEventStream({ client: a, context: () => ({} as EventContext), timelineActive: () => false });
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


it('SSE fallback suppresses duplicate live WS deltas while the socket connects', () => {
  const client = startSession('https://fixture.example', 't', 'manual');
  const context = vi.fn(() => ({} as EventContext));
  const stop = startEventStream({ client, context, timelineActive: () => true });
  const callbacks = vi.mocked(client.connect).mock.calls[0]![0]!;
  const finish = beginTimelineStream(client);
  const event = { type: 'text.delta' as const, episodeId: 'ep', conversationId: 'ep', turnId: 'turn', messageId: 'a', text: 'hello' };
  callbacks.onEvent?.({ seq: 1, at: 0, event });
  expect(context).not.toHaveBeenCalled();
  finish();
  callbacks.onEvent?.({ seq: 2, at: 0, event });
  expect(useTimeline.getState().messages[0]?.parts).toEqual([{ type: 'text', text: 'hello' }]);
  stop();
});

it('a late newest-page load cannot replace a newer source jump', async () => {
  const client = startSession('https://fixture.example', 't', 'manual');
  const old = { id: 'old', episodeId: 'old-ep', conversationId: 'old-ep', role: 'user' as const, parts: [], createdAt: 1, status: 'complete' as const };
  const latest = { ...old, id: 'latest', episodeId: 'new-ep', conversationId: 'new-ep', createdAt: 9 };
  const response = deferred<Awaited<ReturnType<typeof client.timeline.list>>>();
  vi.mocked(client.timeline.list).mockReturnValueOnce(response.promise).mockResolvedValueOnce({ items: [old], episodes: [], nextCursor: null });
  const newest = loadTimeline(client);
  await loadTimeline(client, 'old');
  response.resolve({ items: [latest], episodes: [], nextCursor: null });
  await newest;
  expect(client.timeline.list).toHaveBeenNthCalledWith(2, { limit: 100, around: 'old' });
  expect(useTimeline.getState().messages.map((item) => item.id)).toEqual(['old']);
});


it('clears a cached source page when its off-record message was purged while disconnected', async () => {
  const client = startSession('https://fixture.example', 't', 'manual');
  useTimeline.setState({ messages: [{ id: 'private', episodeId: 'private-ep', conversationId: 'private-ep', role: 'user', parts: [{ type: 'text', text: 'Private text' }], createdAt: 9, status: 'complete' }], loaded: true, hasMore: false, turn: null, confirmations: [], recalled: {}, notices: {}, lastError: null, viewAround: 'private' });
  vi.mocked(client.timeline.list).mockRejectedValueOnce(Object.assign(new Error('Message not found'), { httpStatus: 404 }));
  await expect(loadTimeline(client, 'private')).rejects.toThrow('Message not found');
  expect(useTimeline.getState().messages).toEqual([]);
});

it('a reconnect waits for an in-progress source jump before refreshing that window', async () => {
  const client = startSession('https://fixture.example', 't', 'manual');
  const source = { id: 'source', episodeId: 'ep', conversationId: 'ep', role: 'user' as const, parts: [], createdAt: 1, status: 'complete' as const };
  const response = deferred<Awaited<ReturnType<typeof client.timeline.list>>>();
  vi.mocked(client.timeline.list).mockReturnValueOnce(response.promise).mockResolvedValueOnce({ items: [source], episodes: [], nextCursor: null });
  vi.mocked(client.settings.get).mockResolvedValueOnce(DEFAULT_SETTINGS);
  const jumping = loadTimeline(client, 'source');
  const refresh = refreshAll(client);
  expect(client.timeline.list).toHaveBeenCalledOnce();
  response.resolve({ items: [source], episodes: [], nextCursor: null });
  await Promise.all([jumping, refresh]);
  expect(client.timeline.list).toHaveBeenNthCalledWith(2, { limit: 100, around: 'source' });
  expect(useTimeline.getState()).toMatchObject({ viewAround: 'source', messages: [source] });
});


it('restores server privacy without a browser cache and ignores stale reads after a device event', async () => {
  const client = startSession('https://privacy.example', 'token', 'manual');
  vi.mocked(client.timeline.offRecord).mockResolvedValueOnce({ active: true, episodeId: 'private', startedAt: 10 });
  await loadOffRecord(client);
  expect(useTimeline.getState()).toMatchObject({ offRecord: true, offRecordLoaded: true, episodes: { private: { offRecord: true, ephemeral: true } } });
  let resolve!: (state: { active: boolean; episodeId: null; startedAt: null }) => void;
  vi.mocked(client.timeline.offRecord).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const loading = loadOffRecord(client);
  applyTimelineEvent({ type: 'timeline.off_record', active: true });
  resolve({ active: false, episodeId: null, startedAt: null });
  await loading;
  expect(useTimeline.getState().offRecord).toBe(true);
});
