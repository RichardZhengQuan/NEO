import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS, deepMerge, type ProviderView, type Reminder, type Task } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import type { ReactElement } from 'react';
import { appDictionaries } from '../i18n.js';
import { ProviderSetup } from '../components/ProviderSetup.js';
import { useData } from '../state/data.js';
import { startSession, useSession } from '../state/session.js';
import { TasksScreen } from './TasksScreen.js';
import { RemindersScreen } from './RemindersScreen.js';
import { AiSection } from './settings/AiSection.js';

vi.mock('@neo/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@neo/client')>(),
  NeoClient: vi.fn(() => ({
    timeline: { offRecord: vi.fn().mockResolvedValue({ active: false, episodeId: null, startedAt: null }), startOffRecord: vi.fn().mockResolvedValue({ active: true, episodeId: null, startedAt: 1 }), list: vi.fn() },
    tasks: { update: vi.fn() },
    reminders: { create: vi.fn() },
    providers: { create: vi.fn(), update: vi.fn(), list: vi.fn(), models: vi.fn().mockResolvedValue({ items: [] }) },
  })),
}));
vi.mock('../state/data.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../state/data.js')>(),
  loadTasks: vi.fn().mockResolvedValue(undefined),
  loadReminders: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../platform/index.js', () => ({
  getPlatform: () => ({ notificationStatus: vi.fn().mockResolvedValue({ permission: 'unsupported', reason: 'unsupported' }), syncReminders: vi.fn() }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function renderScreen(child: ReactElement) {
  return render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider>{child}</ConfirmProvider></I18nProvider>);
}

const task: Task = { id: 'task_a', title: 'Server A task', notes: null, listId: 'list_inbox', done: false, doneAt: null, dueAt: null, priority: 0, tags: [], order: 0, parentId: null, createdAt: 0, updatedAt: 0 };
const provider: ProviderView = { id: 'old', kind: 'ollama', label: 'Old provider', enabled: true, hasApiKey: false, isLocal: true };

beforeEach(() => {
  vi.clearAllMocks();
  startSession({ serverUrl: 'https://a.example', token: 'a' }, 'manual');
  useSession.setState({ settings: DEFAULT_SETTINGS });
});
afterEach(cleanup);

describe('screen mutations after a server switch (F10)', () => {
  it.each(['resolve', 'reject'] as const)('late task %s cannot restore A records in B', async (outcome) => {
    const client = useSession.getState().client!;
    const response = deferred<Task>();
    vi.mocked(client.tasks.update).mockReturnValueOnce(response.promise);
    useData.setState({ tasks: { [task.id]: task }, tasksLoaded: true });
    const { unmount } = renderScreen(<TasksScreen />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Done: Server A task' }));
    expect(client.tasks.update).toHaveBeenCalledWith(task.id, { done: true });
    expect(useData.getState().tasks[task.id]!.done).toBe(true);
    unmount();
    startSession({ serverUrl: 'https://b.example', token: 'b' }, 'manual');
    await act(async () => {
      if (outcome === 'resolve') response.resolve({ ...task, done: true });
      else response.reject(new Error('A failed'));
    });
    expect(useData.getState().tasks).toEqual({});
  });

  it('late reminder creation cannot populate B', async () => {
    const client = useSession.getState().client!;
    const response = deferred<Reminder>();
    vi.mocked(client.reminders.create).mockReturnValueOnce(response.promise);
    useData.setState({ remindersLoaded: true });
    const { unmount } = renderScreen(<RemindersScreen />);
    fireEvent.click(screen.getAllByRole('button', { name: 'New reminder' })[0]!);
    fireEvent.change(screen.getByRole('textbox', { name: /Remind me to/ }), { target: { value: 'Server A reminder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create reminder' }));
    expect(client.reminders.create).toHaveBeenCalledTimes(1);
    unmount();
    startSession({ serverUrl: 'https://b.example', token: 'b' }, 'manual');
    await act(async () => { response.resolve({ id: 'rem_a', title: 'A', notes: null, dueAt: 1000, timezone: 'UTC', recurrence: null, status: 'scheduled', firedCount: 0, lastFiredAt: null, messageId: null, createdAt: 0, updatedAt: 0 }); });
    expect(useData.getState().reminders).toEqual({});
  });

  it('late provider enable cannot load A provider ids through B', async () => {
    const client = useSession.getState().client!;
    const response = deferred<ProviderView>();
    vi.mocked(client.providers.update).mockReturnValueOnce(response.promise);
    useSession.setState({ providers: { items: [provider], defaultModel: null }, settings: deepMerge(DEFAULT_SETTINGS, { ai: { mode: 'advanced' } }) });
    const { unmount } = renderScreen(<AiSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable Old provider' }));
    expect(client.providers.update).toHaveBeenCalledWith('old', { enabled: false });
    unmount();
    const b = startSession({ serverUrl: 'https://b.example', token: 'b' }, 'manual');
    await act(async () => { response.resolve({ ...provider, enabled: false }); });
    expect(b.providers.list).not.toHaveBeenCalled();
    expect(useSession.getState().providers).toBeNull();
  });

  it('late provider setup cannot request its models through B', async () => {
    const client = useSession.getState().client!;
    const response = deferred<ProviderView>();
    vi.mocked(client.providers.create).mockReturnValueOnce(response.promise);
    const onDone = vi.fn();
    const { unmount } = renderScreen(<ProviderSetup existing={[]} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(client.providers.create).toHaveBeenCalledTimes(1);
    unmount();
    const b = startSession({ serverUrl: 'https://b.example', token: 'b' }, 'manual');
    await act(async () => { response.resolve(provider); });
    expect(b.providers.list).not.toHaveBeenCalled();
    expect(b.providers.models).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

});
