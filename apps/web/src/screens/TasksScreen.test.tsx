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

describe('TasksScreen timezone', () => {
  it('task row and editor use the configured timezone', () => {
    const DateTimeFormat = Intl.DateTimeFormat;
    const resolvedOptions = new DateTimeFormat().resolvedOptions();
    const resolvedOptionsSpy = vi.spyOn(DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...resolvedOptions, timeZone: 'America/New_York' });
    // resolvedOptions alone does not change the timezone used by native formatting.
    const dateTimeFormatSpy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
      return new DateTimeFormat(locales, { ...options, timeZone: options?.timeZone ?? 'America/New_York' });
    });
    try {
      useSession.setState({ settings: { ...DEFAULT_SETTINGS, timezone: 'Asia/Tokyo' } });
      const dueAt = Date.UTC(2026, 9, 22);
      useData.setState({ tasks: { [task.id]: { ...task, dueAt } } });

      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).not.toBe(useSession.getState().settings?.timezone);
      expect(new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(dueAt)).toBe('Oct 21, 2026');

      render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TasksScreen /></ConfirmProvider></I18nProvider>);
      const row = screen.getByRole('button', { name: /^Old\b/, expanded: false });
      expect(row.textContent).toContain('Oct 22');
      expect(row.textContent).not.toContain('Oct 21');

      fireEvent.click(screen.getByRole('button', { name: 'Details' }));
      expect((screen.getByLabelText('Due date') as HTMLInputElement).value).toBe('2026-10-22');
    } finally {
      dateTimeFormatSpy.mockRestore();
      resolvedOptionsSpy.mockRestore();
    }
  });
});

describe('TasksScreen epoch due date', () => {
  const otherList: TaskList = { ...inbox, id: 'list_other', name: 'Other' };

  beforeEach(() => {
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, timezone: 'America/Los_Angeles' } });
    useData.setState({ tasks: { [task.id]: { ...task, notes: null, dueAt: 0 } }, taskLists: [inbox, otherList] });
    vi.mocked(requireClient().tasks.update).mockImplementation(async (id, patch) => ({ ...useData.getState().tasks[id]!, ...patch }));
  });

  it.each([
    { timezone: 'UTC', date: 'Jan 1, 1970' },
    { timezone: 'America/Los_Angeles', date: 'Dec 31, 1969' },
  ])('shows an epoch-only row date in $timezone', ({ timezone, date }) => {
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, timezone } });
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TasksScreen /></ConfirmProvider></I18nProvider>);

    const row = screen.getByRole('button', { name: /^Old\b/, expanded: false });
    expect(row.querySelector('.row__meta')?.textContent).toBe(` ${date}`);
  });

  it('shows the epoch date alongside other row metadata', () => {
    useData.setState({ tasks: { [task.id]: { ...task, dueAt: 0 } } });
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TasksScreen /></ConfirmProvider></I18nProvider>);

    const row = screen.getByRole('button', { name: /^Old\b/, expanded: false });
    expect(row.querySelector('.row__meta')).not.toBeNull();
    expect(row.textContent).toContain('Dec 31, 1969');
  });

  it.each([
    { timezone: 'UTC', date: '1970-01-01' },
    { timezone: 'America/Los_Angeles', date: '1969-12-31' },
  ])('shows the epoch date in the editor in $timezone', ({ timezone, date }) => {
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, timezone } });
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TasksScreen /></ConfirmProvider></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));

    expect((screen.getByLabelText('Due date') as HTMLInputElement).value).toBe(date);
  });

  it.each([
    { field: 'title', patch: { title: 'Updated title' } },
    { field: 'notes', patch: { notes: 'Updated notes' } },
    { field: 'priority', patch: { priority: 3 } },
    { field: 'list', patch: { listId: otherList.id } },
  ])('keeps the epoch due date when saving $field', async ({ field, patch }) => {
    const view = render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TasksScreen /></ConfirmProvider></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const update = vi.mocked(requireClient().tasks.update);

    await act(async () => {
      if (field === 'title' || field === 'notes') {
        const input = screen.getByRole('textbox', { name: field === 'title' ? 'Title' : 'Notes' });
        fireEvent.change(input, { target: { value: field === 'title' ? 'Updated title' : 'Updated notes' } });
        fireEvent.blur(input);
      } else if (field === 'priority') {
        fireEvent.click(screen.getByRole('radio', { name: 'High' }));
      } else {
        fireEvent.change(screen.getByRole('combobox', { name: 'List' }), { target: { value: otherList.id } });
      }
      expect(update).toHaveBeenCalledExactlyOnceWith(task.id, patch);
      await update.mock.results[0]!.value;
    });

    expect(useData.getState().tasks[task.id]).toMatchObject({ ...patch, dueAt: 0 });
    if (field === 'list') {
      view.rerender(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TasksScreen listId={otherList.id} /></ConfirmProvider></I18nProvider>);
    }
    expect((screen.getByLabelText('Due date') as HTMLInputElement).value).toBe('1969-12-31');
  });

  it('sends null when the epoch due date is cleared', async () => {
    render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TasksScreen /></ConfirmProvider></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const input = screen.getByLabelText('Due date') as HTMLInputElement;
    const update = vi.mocked(requireClient().tasks.update);

    await act(async () => {
      fireEvent.change(input, { target: { value: '' } });
      expect(update).toHaveBeenCalledExactlyOnceWith(task.id, { dueAt: null });
      await update.mock.results[0]!.value;
    });

    expect(useData.getState().tasks[task.id]!.dueAt).toBeNull();
    expect(input.value).toBe('');
    expect(screen.getByRole('button', { name: /^Old\b/, expanded: true }).querySelector('.row__meta')).toBeNull();
  });
});

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
