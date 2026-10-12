/** Contextual scene integration: real router, shell and screens with offline source clients. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { NeoClient } from '@neo/client';
import { DEFAULT_SETTINGS, INBOX_LIST_ID, type Reminder, type Task } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import { Shell } from '../components/Shell.js';
import { appDictionaries } from '../i18n.js';
import { navigate, useRoute } from '../router.js';
import { useData } from '../state/data.js';
import { planForSession } from '../state/plan-tomorrow.js';
import { startSession, useSession } from '../state/session.js';
import { emptyEntry, useTimeline } from '../state/timeline.js';
import { PlanTomorrowScreen } from './PlanTomorrowScreen.js';
import { TasksScreen } from './TasksScreen.js';
import { TimelineScreen } from './TimelineScreen.js';

vi.mock('../connection.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../connection.js')>(),
  createServerClient: vi.fn(() => fakeClient()),
}));
let desktop = true;
vi.mock('../hooks/useMediaQuery.js', () => ({ useIsDesktop: () => desktop, useCoarsePointer: () => false }));

const NOW = Date.parse('2026-10-12T08:00:00Z');
const TOMORROW = '2026-10-13';
let client: NeoClient;
let serverTasks: Task[];
let serverReminders: Reminder[];

function task(overrides: Partial<Task> = {}): Task {
  return { id: 'task_proposal', listId: INBOX_LIST_ID, title: 'Prepare proposal', notes: null, done: false, doneAt: null,
    dueAt: Date.parse('2026-10-13T04:00:00Z'), priority: 3, tags: [], order: 1, parentId: null, createdAt: NOW - 1000, updatedAt: NOW - 1000, ...overrides };
}

function fakeClient(): NeoClient {
  return {
    tasks: {
      list: vi.fn(async () => ({ items: serverTasks })),
      lists: vi.fn(async () => ({ items: [{ id: INBOX_LIST_ID, name: 'Inbox', color: null, icon: 'inbox', order: 0, createdAt: NOW }] })),
      update: vi.fn(),
    },
    reminders: { list: vi.fn(async () => ({ items: serverReminders })), create: vi.fn() },
    timeline: {
      offRecord: vi.fn().mockResolvedValue({ active: false, episodeId: null, startedAt: null }),
      list: vi.fn(async () => ({ items: useTimeline.getState().messages, episodes: [], nextCursor: null })),
      send: vi.fn(), stream: vi.fn(), uiAction: vi.fn(),
    },
    confirmations: { respond: vi.fn() },
  } as unknown as NeoClient;
}

/** Mirrors App's real route-to-screen mapping while omitting unrelated bootstrap networking. */
function RoutedApp() {
  const route = useRoute();
  const content = route.name === 'plan-tomorrow' ? <PlanTomorrowScreen date={route.date} />
    : route.name === 'tasks' ? <TasksScreen listId={route.listId} taskId={route.taskId} />
      : route.name === 'settings' ? <h1>Settings page</h1> : <TimelineScreen />;
  return <Shell route={route}>{content}</Shell>;
}

function show() {
  return render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><RoutedApp /></ConfirmProvider></I18nProvider>);
}

function composer(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Message NEO…' }) as HTMLTextAreaElement;
}

function targetTime(): HTMLInputElement {
  return screen.getByLabelText(/Target time for Prepare proposal/) as HTMLInputElement;
}

function noWrites(): void {
  expect(client.timeline.send).not.toHaveBeenCalled();
  expect(client.timeline.stream).not.toHaveBeenCalled();
  expect(client.timeline.uiAction).not.toHaveBeenCalled();
  expect(client.tasks.update).not.toHaveBeenCalled();
  expect(client.reminders.create).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  desktop = true;
  sessionStorage.clear();
  serverTasks = [task()];
  serverReminders = [];
  client = startSession({ serverUrl: 'https://scene-fixture.example', token: 'offline-scene-owner' }, 'manual');
  useSession.setState({ phase: 'ready', settings: { ...DEFAULT_SETTINGS, timezone: 'Asia/Singapore', onboarded: true }, wsStatus: 'open',
    providers: { items: [{ id: 'local', kind: 'ollama', label: 'Local AI', enabled: true, defaultModel: 'model', hasApiKey: false, isLocal: true }], defaultModel: { provider: 'local', model: 'model' } } });
  useTimeline.setState({ ...emptyEntry(), loaded: true, offRecordLoaded: true }, true);
  window.history.replaceState({}, '', '#/');
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('on-demand Plan tomorrow entry', () => {
  it.each(['Plan tomorrow', '帮我规划明天'])('opens the scene directly for "%s" without a chat request or saved-data mutation', async (request) => {
    show();
    fireEvent.change(composer(), { target: { value: request } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByRole('heading', { name: 'Plan tomorrow' });
    await screen.findByLabelText(/Target time for Prepare proposal/);

    expect(window.location.hash).toBe(`#/plan-tomorrow?date=${TOMORROW}`);
    expect(planForSession(TOMORROW, 'Asia/Singapore')?.intent).toBe(request);
    expect(useTimeline.getState().messages).toEqual([]);
    expect(client.tasks.list).toHaveBeenCalled();
    expect(client.reminders.list).toHaveBeenCalled();
    noWrites();
  });

  it('keeps the scene choices and an unrelated composer draft through return, resume and remount', async () => {
    const view = show();
    fireEvent.change(composer(), { target: { value: 'Keep this unfinished question.' } });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Tasks' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Plan tomorrow' }));
    await screen.findByLabelText(/Target time for Prepare proposal/);
    fireEvent.change(targetTime(), { target: { value: '10:45' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Add reminder for Prepare proposal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to NEO' }));
    await screen.findByRole('textbox', { name: 'Message NEO…' });
    expect(composer().value).toBe('Keep this unfinished question.');
    fireEvent.click(screen.getByRole('button', { name: 'Resume plan' }));
    await screen.findByLabelText(/Target time for Prepare proposal/);
    expect(targetTime().value).toBe('10:45');
    expect((screen.getByRole('checkbox', { name: 'Add reminder for Prepare proposal' }) as HTMLInputElement).checked).toBe(true);

    view.unmount();
    show();

    expect(targetTime().value).toBe('10:45');
    expect((screen.getByRole('checkbox', { name: 'Add reminder for Prepare proposal' }) as HTMLInputElement).checked).toBe(true);
    noWrites();
  });

  it('offers contextual Tasks entry only after existing unfinished tasks are loaded', async () => {
    serverTasks = [task({ done: true, doneAt: NOW })];
    window.history.replaceState({}, '', '#/tasks');
    show();
    await waitFor(() => expect(useData.getState().tasksLoaded).toBe(true));
    expect(screen.queryByRole('button', { name: 'Plan tomorrow' })).toBeNull();
    serverTasks = [task()];
    act(() => useData.setState({ tasks: { task_proposal: serverTasks[0]! }, tasksLoaded: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Plan tomorrow' }));

    await screen.findByLabelText(/Target time for Prepare proposal/);

    expect(window.location.hash).toBe(`#/plan-tomorrow?date=${TOMORROW}`);
    noWrites();
  });

  it.each([true, false])('keeps the scene out of permanent navigation on desktop=%s', async (wide) => {
    desktop = wide;
    window.history.replaceState({}, '', `#/plan-tomorrow?date=${TOMORROW}`);
    show();
    await screen.findByLabelText(/Target time for Prepare proposal/);
    const navigation = within(screen.getByRole('navigation', { name: 'Main' }));
    expect(navigation.getAllByRole('button')).toHaveLength(6);
    expect(navigation.queryByRole('button', { name: 'Plan tomorrow' })).toBeNull();
    expect(navigation.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['NEO', 'Memory', 'Reminders', 'Tasks', 'Notes', 'Settings']);
    noWrites();
  });

  it('loads privacy for a cold direct scene URL even while the event socket is not open', async () => {
    useTimeline.setState({ offRecordLoaded: false });
    useSession.setState({ wsStatus: 'idle' });
    vi.mocked(client.timeline.offRecord).mockImplementationOnce(async () => {
      expect(client.tasks.list).not.toHaveBeenCalled();
      return { active: false, episodeId: null, startedAt: null };
    });
    window.history.replaceState({}, '', `#/plan-tomorrow?date=${TOMORROW}`);
    show();

    await waitFor(() => expect(client.timeline.offRecord).toHaveBeenCalledTimes(1));
    await screen.findByLabelText(/Target time for Prepare proposal/);

    expect(useTimeline.getState().offRecordLoaded).toBe(true);
    noWrites();
  });

  it('surfaces a failed cold privacy read and retries it before reading planning sources', async () => {
    useTimeline.setState({ offRecordLoaded: false });
    useSession.setState({ wsStatus: 'idle' });
    vi.mocked(client.timeline.offRecord).mockRejectedValueOnce(new Error('Privacy read unavailable'));
    window.history.replaceState({}, '', `#/plan-tomorrow?date=${TOMORROW}`);
    show();
    await screen.findByRole('alert');
    expect(client.tasks.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByLabelText(/Target time for Prepare proposal/);

    expect(client.timeline.offRecord).toHaveBeenCalledTimes(2);
    expect(useTimeline.getState().offRecordLoaded).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    noWrites();
  });

  it('recovers a cold direct scene URL from a source-read failure without applying changes', async () => {
    vi.mocked(client.tasks.list).mockRejectedValueOnce(new Error('Source read unavailable'));
    window.history.replaceState({}, '', `#/plan-tomorrow?date=${TOMORROW}`);
    show();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Couldn’t load your tasks and reminders.'));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByLabelText(/Target time for Prepare proposal/);

    expect(planForSession(TOMORROW, 'Asia/Singapore')?.status).toBe('ready');
    expect(client.tasks.list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    noWrites();
  });

  it('reviews the latest before value after an explicit source refresh', async () => {
    window.history.replaceState({}, '', `#/plan-tomorrow?date=${TOMORROW}`);
    show();
    await screen.findByLabelText(/Target time for Prepare proposal/);
    fireEvent.change(targetTime(), { target: { value: '10:45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }));
    const originalBefore = planForSession(TOMORROW, 'Asia/Singapore')!.operations[0]!.before;
    const latest = task({ dueAt: Date.parse('2026-10-13T10:00:00Z'), updatedAt: NOW });
    serverTasks = [latest];
    act(() => useData.setState({ tasks: { [latest.id]: latest } }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' }));
    await waitFor(() => expect(planForSession(TOMORROW, 'Asia/Singapore')?.status).toBe('ready'));
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }));

    expect(planForSession(TOMORROW, 'Asia/Singapore')!.operations[0]!.before).not.toBe(originalBefore);
    expect(planForSession(TOMORROW, 'Asia/Singapore')!.operations[0]!.before).toBe(latest.dueAt);
    noWrites();
  });
});
