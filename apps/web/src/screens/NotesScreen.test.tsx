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
import { startSession } from '../state/session.js';

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
    await act(async () => { resolve(serverNote); });

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
    await act(async () => { resolveFirst(makeNote({ content: 'First revision', updatedAt: 2000 })); });

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
    await act(async () => { fireEvent.click(retryBtn); });

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

  it('serializes overlapping saves and sends only the latest pending revision', async () => {
    let resolveFirst!: (n: Note) => void;
    let resolveLatest!: (n: Note) => void;
    let active = 0;
    let maxActive = 0;
    mockUpdate.mockImplementation((_id, patch) => {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise<Note>((resolve) => {
        const finish = (n: Note) => { active--; resolve(n); };
        if (patch.content === 'First') resolveFirst = finish;
        else resolveLatest = finish;
      });
    });
    const { unmount } = await renderEditor(makeNote());
    const textarea = screen.getByRole('textbox', { name: /content/i });
    fireEvent.change(textarea, { target: { value: 'First' } });
    await act(() => vi.advanceTimersByTimeAsync(700));
    fireEvent.change(textarea, { target: { value: 'Intermediate' } });
    await act(() => vi.advanceTimersByTimeAsync(700));
    fireEvent.change(textarea, { target: { value: 'Latest' } });
    fireEvent.change(screen.getByRole('textbox', { name: /title/i }), { target: { value: 'Latest title' } });
    await act(() => vi.advanceTimersByTimeAsync(700));
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toMatch(/unsaved/i);

    await act(async () => { resolveFirst(makeNote({ content: 'First', updatedAt: 2000 })); });
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenLastCalledWith('note_1', { title: 'Latest title', content: 'Latest', tags: [], pinned: false });
    expect(upsertedNotes).toEqual([]);
    expect((textarea as HTMLTextAreaElement).value).toBe('Latest');
    expect(screen.getByRole('status').textContent).toMatch(/saving/i);
    await act(async () => { resolveLatest(makeNote({ title: 'Latest title', content: 'Latest', updatedAt: 3000 })); });
    expect(maxActive).toBe(1);
    expect(useData.getState().notes.note_1!.content).toBe('Latest');
    expect(screen.getByRole('status').textContent).toMatch(/saved/i);
    unmount();
  });

  it('continues the queued latest save after an older request fails', async () => {
    let rejectFirst!: (e: Error) => void;
    mockUpdate.mockReturnValueOnce(new Promise<Note>((_resolve, reject) => { rejectFirst = reject; }));
    mockUpdate.mockRejectedValueOnce(new Error('latest failed'));
    mockUpdate.mockResolvedValueOnce(makeNote({ content: 'Latest', updatedAt: 3000 }));
    const { unmount } = await renderEditor(makeNote());
    const textarea = screen.getByRole('textbox', { name: /content/i });
    fireEvent.change(textarea, { target: { value: 'First' } });
    await act(() => vi.advanceTimersByTimeAsync(700));
    fireEvent.change(textarea, { target: { value: 'Latest' } });
    await act(() => vi.advanceTimersByTimeAsync(700));
    await act(async () => { rejectFirst(new Error('old failed')); });
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect((textarea as HTMLTextAreaElement).value).toBe('Latest');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /retry/i })); });
    expect(mockUpdate).toHaveBeenCalledTimes(3);
    expect(mockUpdate).toHaveBeenLastCalledWith('note_1', expect.objectContaining({ content: 'Latest' }));
    expect(upsertedNotes.map((n) => n.content)).toEqual(['Latest']);
    unmount();
  });

  it('leaving during an in-flight save queues the latest edit behind it', async () => {
    let resolveFirst!: (n: Note) => void;
    mockUpdate.mockReturnValueOnce(new Promise<Note>((resolve) => { resolveFirst = resolve; }));
    mockUpdate.mockResolvedValueOnce(makeNote({ content: 'Leaving latest', updatedAt: 3000 }));
    const { unmount } = await renderEditor(makeNote());
    const textarea = screen.getByRole('textbox', { name: /content/i });
    fireEvent.change(textarea, { target: { value: 'First' } });
    await act(() => vi.advanceTimersByTimeAsync(700));
    fireEvent.change(textarea, { target: { value: 'Leaving latest' } });
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    await act(async () => { resolveFirst(makeNote({ content: 'First', updatedAt: 2000 })); });
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenLastCalledWith('note_1', expect.objectContaining({ content: 'Leaving latest' }));
    expect(upsertedNotes.map((n) => n.content)).toEqual(['Leaving latest']);
  });


  it('serializes pin changes with content and tags without applying the old snapshot', async () => {
    let resolvePin!: (n: Note) => void;
    mockUpdate.mockReturnValueOnce(new Promise<Note>((resolve) => { resolvePin = resolve; }));
    mockUpdate.mockResolvedValueOnce(makeNote({ content: 'Newest text', tags: ['work'], pinned: true, updatedAt: 3000 }));
    const { unmount } = await renderEditor(makeNote());
    fireEvent.click(screen.getByRole('button', { name: /^pin$/i }));
    expect(mockUpdate).toHaveBeenCalledWith('note_1', expect.objectContaining({ pinned: true }));
    const textarea = screen.getByRole('textbox', { name: /content/i });
    fireEvent.change(textarea, { target: { value: 'Newest text' } });
    const tags = screen.getByRole('textbox', { name: /tags/i });
    fireEvent.change(tags, { target: { value: 'work' } });
    fireEvent.keyDown(tags, { key: 'Enter' });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    await act(async () => { resolvePin(makeNote({ pinned: true, updatedAt: 2000 })); });
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenLastCalledWith('note_1', expect.objectContaining({ content: 'Newest text', tags: ['work'], pinned: true }));
    expect(upsertedNotes.map((n) => n.content)).toEqual(['Newest text']);
    expect((textarea as HTMLTextAreaElement).value).toBe('Newest text');
    unmount();
  });


  it('does not save queued edits or apply an old response after switching servers', async () => {
    let resolveFirst!: (n: Note) => void;
    mockUpdate.mockReturnValueOnce(new Promise<Note>((resolve) => { resolveFirst = resolve; }));
    const { unmount } = await renderEditor(makeNote());
    const textarea = screen.getByRole('textbox', { name: /content/i });
    fireEvent.change(textarea, { target: { value: 'First' } });
    await act(() => vi.advanceTimersByTimeAsync(700));
    fireEvent.change(textarea, { target: { value: 'Queued' } });
    unmount();
    startSession({ serverUrl: 'https://new.example', token: 'token' }, 'manual');
    await act(() => vi.advanceTimersByTimeAsync(10));
    await act(async () => { resolveFirst(makeNote({ content: 'First', updatedAt: 2000 })); });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(upsertedNotes).toEqual([]);
    expect(useData.getState().notes).toEqual({});
  });

});
