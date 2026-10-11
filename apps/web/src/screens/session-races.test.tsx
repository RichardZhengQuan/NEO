import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS, type Conversation, type ProviderView, type Reminder, type Task } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import type { ReactElement } from 'react';
import { appDictionaries } from '../i18n.js';
import { ConversationList } from '../components/ConversationList.js';
import { useConversations } from '../state/conversations.js';
import { ProviderSetup } from '../components/ProviderSetup.js';
import { useData } from '../state/data.js';
import { startSession, useSession } from '../state/session.js';
import { TasksScreen } from './TasksScreen.js';
import { RemindersScreen } from './RemindersScreen.js';
import { AiSection } from './settings/AiSection.js';

vi.mock('@neo/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@neo/client')>(),
  NeoClient: vi.fn(() => ({
    conversations: { list: vi.fn() },
    tasks: { update: vi.fn() },
    reminders: { create: vi.fn() },
    providers: { create: vi.fn(), update: vi.fn(), list: vi.fn(), models: vi.fn() },
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
const provider: ProviderView = { id: 'old', kind: 'mock', label: 'Old provider', enabled: true, hasApiKey: false, isLocal: true };

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
    await act(async () => { response.resolve({ id: 'rem_a', title: 'A', notes: null, dueAt: 1000, timezone: 'UTC', recurrence: null, status: 'scheduled', firedCount: 0, lastFiredAt: null, conversationId: null, createdAt: 0, updatedAt: 0 }); });
    expect(useData.getState().reminders).toEqual({});
  });

  it('late provider enable cannot load A provider ids through B', async () => {
    const client = useSession.getState().client!;
    const response = deferred<ProviderView>();
    vi.mocked(client.providers.update).mockReturnValueOnce(response.promise);
    useSession.setState({ providers: { items: [provider], defaultModel: null } });
    const { unmount } = renderScreen(<AiSection />);
    fireEvent.click(screen.getByRole('switch', { name: 'Use Old provider' }));
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
    fireEvent.click(screen.getByRole('button', { name: /Demo mode/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use demo mode' }));
    expect(client.providers.create).toHaveBeenCalledTimes(1);
    unmount();
    const b = startSession({ serverUrl: 'https://b.example', token: 'b' }, 'manual');
    await act(async () => { response.resolve(provider); });
    expect(b.providers.list).not.toHaveBeenCalled();
    expect(b.providers.models).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('late archived-conversation loads cannot repopulate B', async () => {
    const client = useSession.getState().client!;
    const response = deferred<{ items: Conversation[] }>();
    vi.mocked(client.conversations.list).mockReturnValueOnce(response.promise);
    useConversations.setState({ listLoaded: true });
    const { unmount } = renderScreen(<ConversationList activeId={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Archived chats' }));
    expect(client.conversations.list).toHaveBeenCalledWith({ archived: true, limit: 200 });
    unmount();
    startSession({ serverUrl: 'https://b.example', token: 'b' }, 'manual');
    await act(async () => { response.resolve({ items: [{ id: 'conv_a', title: 'A', model: null, incognito: false, pinned: false, archived: true, createdAt: 0, updatedAt: 0, systemPrompt: null, toolset: null, lastMessageAt: null, preview: null }] }); });
    expect(useConversations.getState().conversations).toEqual({});
    expect(useConversations.getState().archivedLoaded).toBe(false);
  });

});
