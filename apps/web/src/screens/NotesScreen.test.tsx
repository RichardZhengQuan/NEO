/**
 * NoteEditor autosave race-condition tests (F08).
 *
 * Verifies that a slower first save cannot overwrite content the user typed
 * while the request was in flight, and that the editor serialises saves
 * correctly when multiple flushes overlap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Note } from '@neo/protocol';
import { useData } from '../state/data.js';

// ── module mocks ──────────────────────────────────────────────────────────────

const mockUpdate = vi.fn();
const mockNotesList = vi.fn().mockResolvedValue({ items: [] });
vi.mock('../state/session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/session.js')>();
  return {
    ...actual,
    requireClient: () => ({
      notes: { update: mockUpdate, list: mockNotesList, delete: vi.fn().mockResolvedValue(undefined) },
    }),
  };
});

vi.mock('../router.js', () => ({
  navigate: vi.fn(),
  parseRoute: vi.fn(),
  routeToHash: vi.fn().mockReturnValue(''),
}));

// Capture every note written to the store so we can assert on it.
const upsertedNotes: Note[] = [];
vi.mock('../state/data.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/data.js')>();
  return {
    ...actual,
    // Prevent the background notes load from clearing the store mid-test: the
    // useEffect in NotesScreen calls loadNotes on mount, but its pre-resolved
    // promise flushes inside act() and would wipe the manually-seeded note.
    loadNotes: vi.fn().mockResolvedValue(undefined),
    upsertNote: (n: Note) => {
      upsertedNotes.push(n);
      actual.upsertNote(n);
    },
  };
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeNote(over: Partial<Note> = {}): Note {
  return {
    id: 'note_1',
    title: 'Test note',
    content: '',
    tags: [],
    pinned: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

async function renderEditor(note: Note) {
  // Dynamic import so mocks are applied first (vitest hoists vi.mock calls).
  const { NotesScreen } = await import('./NotesScreen.js');
  useData.setState((s) => ({ ...s, notes: { [note.id]: note }, notesLoaded: true }));
  return render(<NotesScreen noteId={note.id} />);
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  mockUpdate.mockReset();
  mockNotesList.mockResolvedValue({ items: [] });
  upsertedNotes.length = 0;
  useData.setState({
    notes: {},
    notesLoaded: false,
    reminders: {},
    remindersLoaded: false,
    tasks: {},
    taskLists: [],
    tasksLoaded: false,
    memoryVersion: 0,
    pendingMemories: 0,
    notifications: [],
    unreadNotifications: 0,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('NoteEditor autosave', () => {
  it('marks the editor saved when a flush completes without concurrent edits', async () => {
    const note = makeNote();
    const serverNote = makeNote({ content: 'Hello', updatedAt: 2000 });
    let resolve!: (n: Note) => void;
    mockUpdate.mockReturnValueOnce(new Promise<Note>((r) => { resolve = r; }));

    const { unmount } = await renderEditor(note);

    const textarea = screen.getByRole('textbox', { name: /content/i });
    fireEvent.change(textarea, { target: { value: 'Hello' } });

    // Advance past the 700ms debounce so flush() fires.
    await act(() => vi.advanceTimersByTimeAsync(700));

    // Resolve the request — no new edits so the status should show saved.
    await act(() => { resolve(serverNote); });

    // The status area should not say "unsaved" (it shows "Saved")
    const status = screen.getByRole('status');
    expect(status.textContent).not.toMatch(/unsaved/i);
    expect(upsertedNotes).toHaveLength(1);
    unmount();
  });

  it('does not overwrite newer content when an older save resolves (F08 repro)', async () => {
    const note = makeNote();

    // Deferred first response.
    let resolveFirst!: (n: Note) => void;
    mockUpdate.mockReturnValueOnce(new Promise<Note>((r) => { resolveFirst = r; }));
    // Second save resolves immediately.
    mockUpdate.mockResolvedValueOnce(makeNote({ content: 'Second revision', updatedAt: 3000 }));

    const { unmount } = await renderEditor(note);
    const textarea = screen.getByRole('textbox', { name: /content/i });

    // 1. Type "First revision" and let the debounce fire.
    fireEvent.change(textarea, { target: { value: 'First revision' } });
    await act(() => vi.advanceTimersByTimeAsync(700));

    // First save is in flight. Type more content while it is pending.
    fireEvent.change(textarea, { target: { value: 'Second revision' } });

    // 2. Resolve the *first* (stale) save — must NOT overwrite the editor.
    await act(() => { resolveFirst(makeNote({ content: 'First revision', updatedAt: 2000 })); });

    // Editor should still show "Second revision".
    expect((textarea as HTMLTextAreaElement).value).toBe('Second revision');
    // The stale response must not have been applied to the store.
    expect(upsertedNotes.find((n) => n.content === 'First revision')).toBeUndefined();

    // 3. Advance so the second debounce timer fires and the second save resolves.
    await act(() => vi.advanceTimersByTimeAsync(700));

    expect((textarea as HTMLTextAreaElement).value).toBe('Second revision');
    expect(upsertedNotes.find((n) => n.content === 'Second revision')).toBeDefined();

    unmount();
  });

  it('retries after a save error via the retry button', async () => {
    const note = makeNote();

    mockUpdate.mockRejectedValueOnce(new Error('network'));
    mockUpdate.mockResolvedValueOnce(makeNote({ content: 'Retry me', updatedAt: 2000 }));

    const { unmount } = await renderEditor(note);
    const textarea = screen.getByRole('textbox', { name: /content/i });
    fireEvent.change(textarea, { target: { value: 'Retry me' } });
    await act(() => vi.advanceTimersByTimeAsync(700));

    // After the failure a retry button should appear (aria-label "Retry").
    const retryBtn = screen.getByRole('button', { name: /retry/i });
    await act(() => { fireEvent.click(retryBtn); });

    expect(upsertedNotes).toHaveLength(1);
    unmount();
  });

  it('saves the latest content when the editor is left with a pending timer', async () => {
    const note = makeNote();

    mockUpdate.mockResolvedValueOnce(makeNote({ content: 'Leaving', updatedAt: 2000 }));

    const { unmount } = await renderEditor(note);
    const textarea = screen.getByRole('textbox', { name: /content/i });
    fireEvent.change(textarea, { target: { value: 'Leaving' } });

    // Unmount before the 700ms timer fires (simulates navigating away).
    unmount();
    // Let the cleanup timeout run (0ms defer in the effect).
    await act(() => vi.advanceTimersByTimeAsync(10));

    expect(mockUpdate).toHaveBeenCalledWith(note.id, expect.objectContaining({ content: 'Leaving' }));
  });
});
