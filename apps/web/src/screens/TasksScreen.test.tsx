import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS, INBOX_LIST_ID, type Task, type TaskList } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { useData } from '../state/data.js';
import { requireClient, startSession, useSession } from '../state/session.js';
import { TasksScreen } from './TasksScreen.js';

vi.mock('@neo/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@neo/client')>(),
  NeoClient: vi.fn(() => ({ tasks: { update: vi.fn() } })),
}));
vi.mock('../state/data.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../state/data.js')>(),
  loadTasks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../hooks/useMediaQuery.js', () => ({ useIsDesktop: () => true }));

const task: Task = { id: 'task_sync', listId: INBOX_LIST_ID, title: 'Old', notes: 'Old notes', done: false, doneAt: null, dueAt: null, priority: 0, tags: [], order: 0, parentId: null, createdAt: 0, updatedAt: 0 };
const inbox: TaskList = { id: INBOX_LIST_ID, name: 'Inbox', color: null, icon: null, order: 0, createdAt: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  startSession({ serverUrl: 'https://tasks.example', token: 'test' }, 'manual');
  useSession.setState({ settings: DEFAULT_SETTINGS });
  useData.setState({ tasks: { [task.id]: task }, taskLists: [inbox], tasksLoaded: true });
  vi.mocked(requireClient().tasks.update).mockImplementation(async (_id, patch) => ({ ...task, ...patch }));
});
afterEach(cleanup);

describe('TaskDetails store updates', () => {
  it('resyncs an untouched title before blur so it cannot overwrite a remote update', async () => {
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TasksScreen /></ConfirmProvider></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const input = screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement;
    expect(input.value).toBe('Old');

    act(() => { useData.setState({ tasks: { [task.id]: { ...task, title: 'New', updatedAt: 1 } } }); });
    expect(screen.getByRole('button', { name: /^New\b/, expanded: true })).toBeTruthy();
    await act(async () => { fireEvent.blur(input); });

    expect(requireClient().tasks.update).not.toHaveBeenCalled();
    expect(input.value).toBe('New');
    expect(useData.getState().tasks[task.id]!.title).toBe('New');
  });

  it('preserves a notes draft when only task.title is updated remotely', async () => {
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TasksScreen /></ConfirmProvider></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const notesInput = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;

    // user types in the notes field
    fireEvent.change(notesInput, { target: { value: 'User draft notes' } });
    expect(notesInput.value).toBe('User draft notes');

    // remote updates only task.title — notes unchanged remotely
    act(() => { useData.setState({ tasks: { [task.id]: { ...task, title: 'New title', updatedAt: 1 } } }); });

    // notes draft must be preserved
    expect(notesInput.value).toBe('User draft notes');
  });

  it('preserves a title draft when only task.notes is updated remotely', async () => {
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TasksScreen /></ConfirmProvider></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const titleInput = screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement;

    // user types in the title field
    fireEvent.change(titleInput, { target: { value: 'User draft title' } });
    expect(titleInput.value).toBe('User draft title');

    // remote updates only task.notes — title unchanged remotely
    act(() => { useData.setState({ tasks: { [task.id]: { ...task, notes: 'New notes', updatedAt: 1 } } }); });

    // title draft must be preserved
    expect(titleInput.value).toBe('User draft title');
  });

  it('resyncs untouched notes before blur so they cannot overwrite a remote update', async () => {
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TasksScreen /></ConfirmProvider></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const input = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    expect(input.value).toBe('Old notes');

    act(() => { useData.setState({ tasks: { [task.id]: { ...task, notes: 'New notes', updatedAt: 1 } } }); });
    await act(async () => { fireEvent.blur(input); });

    expect(requireClient().tasks.update).not.toHaveBeenCalled();
    expect(input.value).toBe('New notes');
    expect(useData.getState().tasks[task.id]!.notes).toBe('New notes');
  });

  it('preserves a title draft when a remote update changes the same title field', async () => {
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TasksScreen /></ConfirmProvider></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const input = screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement;

    // User types a draft title
    fireEvent.change(input, { target: { value: 'User draft' } });
    expect(input.value).toBe('User draft');

    // Remote update changes the same title field to something different
    act(() => { useData.setState({ tasks: { [task.id]: { ...task, title: 'Remote title', updatedAt: 1 } } }); });

    // Local draft must survive — must NOT be overwritten by the remote value
    expect(input.value).toBe('User draft');
  });

  it('preserves a notes draft when a remote update changes the same notes field', async () => {
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TasksScreen /></ConfirmProvider></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const input = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;

    // User types a draft
    fireEvent.change(input, { target: { value: 'User draft notes' } });
    expect(input.value).toBe('User draft notes');

    // Remote update changes the same notes field
    act(() => { useData.setState({ tasks: { [task.id]: { ...task, notes: 'Remote notes', updatedAt: 1 } } }); });

    // Local draft must survive
    expect(input.value).toBe('User draft notes');
  });
});
