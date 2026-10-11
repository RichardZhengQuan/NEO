/**
 * F10: Conversation caches are cleared on server switch, and in-flight
 * responses from the old server are discarded after switching.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Note } from '@neo/protocol';
import { NeoClient } from '@neo/client';
import { useConversations } from './conversations.js';
import { loadNotes, useData } from './data.js';
import { loadConversationList } from './connection.js';
import { startSession, useSession } from './session.js';

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
      confirmations: { list: vi.fn() },
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
  useSession.setState((s) => ({ ...s, phase: 'booting', sessionEpoch: 0 }));
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

  it('late response from server A does not populate server B store', async () => {
    // Start server A session.
    const clientA = startSession('https://server-a.example', 'tok_a', 'manual');

    // Begin a slow notes load for server A (defer the response).
    let resolveA!: (v: { items: Note[] }) => void;
    vi.mocked(clientA.notes.list).mockReturnValueOnce(new Promise((r) => { resolveA = r; }));
    const pendingLoad = loadNotes(clientA);

    // Switch to server B before the response arrives.
    startSession('https://server-b.example', 'tok_b', 'manual');

    // Now resolve server A's response.
    resolveA({ items: [makeNote('note_a_late', 'Late note from A')] });
    await pendingLoad;

    // Server A's data must NOT appear in the store.
    expect(useData.getState().notes).toEqual({});
    expect(useData.getState().notesLoaded).toBe(false);
  });
});
