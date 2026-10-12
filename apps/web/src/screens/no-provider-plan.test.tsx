/** Provider-free planning remains usable while ordinary drafts never become chat requests. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NeoClient } from '@neo/client';
import { DEFAULT_SETTINGS, INBOX_LIST_ID, type Task } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { navigate, useRoute } from '../router.js';
import { startSession, useSession } from '../state/session.js';
import { emptyEntry, useTimeline } from '../state/timeline.js';
import { PlanTomorrowScreen } from './PlanTomorrowScreen.js';
import { TimelineScreen } from './TimelineScreen.js';

vi.mock('../connection.js', async (original) => ({ ...await original<typeof import('../connection.js')>(), createServerClient: vi.fn(() => fakeClient()) }));
vi.mock('../hooks/useMediaQuery.js', () => ({ useCoarsePointer: () => false, useIsDesktop: () => true }));
let client: NeoClient;
const NOW = Date.parse('2026-10-12T08:00:00Z');
const task: Task = { id: 'task_proposal', listId: INBOX_LIST_ID, title: 'Prepare proposal', notes: null, done: false, doneAt: null, dueAt: null, priority: 3, tags: [], order: 1, parentId: null, createdAt: NOW, updatedAt: NOW };
function fakeClient(): NeoClient {
  return {
    tasks: { list: vi.fn(async () => ({ items: [task] })), get: vi.fn(async () => task), update: vi.fn() },
    reminders: { list: vi.fn(async () => ({ items: [] })), create: vi.fn() },
    timeline: { offRecord: vi.fn().mockResolvedValue({ active: false, episodeId: null, startedAt: null }), list: vi.fn(async () => ({ items: [], episodes: [], nextCursor: null })), send: vi.fn(), stream: vi.fn(), uiAction: vi.fn() },
  } as unknown as NeoClient;
}
function Pages() {
  const route = useRoute();
  return route.name === 'plan-tomorrow' ? <PlanTomorrowScreen date={route.date} /> : route.name === 'settings' ? <h1>Settings page</h1> : <TimelineScreen />;
}
function show(locale = 'en') { return render(<I18nProvider locale={locale} messages={appDictionaries}><ConfirmProvider><Pages /></ConfirmProvider></I18nProvider>); }
function textarea() { return screen.getByRole('textbox') as HTMLTextAreaElement; }
function noWrites() {
  expect(client.timeline.send).not.toHaveBeenCalled();
  expect(client.timeline.stream).not.toHaveBeenCalled();
  expect(client.timeline.uiAction).not.toHaveBeenCalled();
  expect(client.tasks.update).not.toHaveBeenCalled();
  expect(client.reminders.create).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sessionStorage.clear();
  client = startSession({ serverUrl: 'https://provider-free.example', token: 'offline-fixture' }, 'manual');
  useSession.setState({ phase: 'ready', settings: { ...DEFAULT_SETTINGS, timezone: 'Asia/Singapore', onboarded: true }, providers: { items: [], defaultModel: null }, wsStatus: 'open' });
  useTimeline.setState({ ...emptyEntry(), loaded: true, offRecordLoaded: true }, true);
  window.history.replaceState({}, '', '#/');
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('planning without an AI provider', () => {
  it.each([['en', 'Plan tomorrow', 'click'], ['zh-CN', '规划明天', 'enter']])('opens the local scene in %s with zero chat or write requests', async (locale, request, input) => {
    show(locale);
    expect(textarea().disabled).toBe(false);
    fireEvent.change(textarea(), { target: { value: request } });
    const send = screen.getByRole('button', { name: locale === 'en' ? 'Send' : '发送' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    if (input === 'enter') fireEvent.keyDown(textarea(), { key: 'Enter' });
    else fireEvent.click(send);
    await screen.findByRole('heading', { name: locale === 'en' ? 'Plan tomorrow' : '规划明天', level: 1 });
    await waitFor(() => expect(client.tasks.list).toHaveBeenCalled());
    expect(window.location.hash).toBe('#/plan-tomorrow?date=2026-10-13');
    expect(useTimeline.getState().messages).toEqual([]);
    noWrites();
  });

  it('retains an unrelated draft across pages while Send and Enter remain unavailable', async () => {
    show();
    const draft = 'Keep this unrelated unfinished question.\nWith exact wording.';
    fireEvent.change(textarea(), { target: { value: draft } });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(textarea().value).toBe(draft);
    act(() => navigate({ name: 'settings', section: 'ai' }));
    await screen.findByRole('heading', { name: 'Settings page' });
    act(() => navigate({ name: 'timeline' }));
    await screen.findByRole('textbox');
    expect(textarea().value).toBe(draft);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    noWrites();
  });

  it('keeps the normal chat send path after an enabled provider is available', async () => {
    useSession.setState({ providers: { items: [{ id: 'local', kind: 'ollama', label: 'Local AI', enabled: true, defaultModel: 'model', hasApiKey: false, isLocal: true }], defaultModel: { provider: 'local', model: 'model' } } });
    vi.mocked(client.timeline.send).mockResolvedValue({ turnId: 'turn_test', episodeId: 'ep_test', assistantMessageId: 'assistant_test', userMessage: {
      id: 'user_test', episodeId: 'ep_test', conversationId: 'ep_test', role: 'user', parts: [{ type: 'text', text: 'An ordinary question' }], createdAt: NOW, status: 'complete',
    } });
    show();
    fireEvent.change(textarea(), { target: { value: 'An ordinary question' } });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    await waitFor(() => expect(client.timeline.send).toHaveBeenCalledWith({ text: 'An ordinary question' }));
    expect(window.location.hash).toBe('#/');
    expect(client.tasks.update).not.toHaveBeenCalled();
    expect(client.reminders.create).not.toHaveBeenCalled();
  });

  it('keeps a command with an image unsendable until the attachment is removed', async () => {
    const view = show();
    fireEvent.change(textarea(), { target: { value: 'Plan tomorrow' } });
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(['fixture'], 'draft.png', { type: 'image/png' })] } });
    await screen.findByRole('img', { name: 'draft.png' });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(textarea().value).toBe('Plan tomorrow');
    expect(window.location.hash).toBe('#/');
    noWrites();
    fireEvent.click(screen.getByRole('button', { name: 'Remove draft.png' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('heading', { name: 'Plan tomorrow', level: 1 });
    noWrites();
  });
});
