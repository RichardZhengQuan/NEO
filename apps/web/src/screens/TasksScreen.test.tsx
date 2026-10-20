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
});
