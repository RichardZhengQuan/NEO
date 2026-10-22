/** App integration: route changes retain chat input without crossing session/privacy boundaries. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NeoClient } from '@neo/client';
import { DEFAULT_SETTINGS, type Message, type UIBlock } from '@neo/protocol';
import { ConfirmProvider, I18nProvider, buildMessages, createTranslator } from '@neo/ui';
import { deleteMessage, setOffRecord } from '../actions/timeline.js';
import { appDictionaries } from '../i18n.js';
import { navigate, useRoute } from '../router.js';
import { resetChatDrafts } from '../state/chat-drafts.js';
import { showConnect, startSession, useSession } from '../state/session.js';
import { applyTimelineEvent, emptyEntry, useTimeline } from '../state/timeline.js';
import { TimelineScreen } from './TimelineScreen.js';

vi.mock('../connection.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../connection.js')>(),
  createServerClient: vi.fn(() => makeClient()),
}));

const t = createTranslator('en', buildMessages('en', appDictionaries));
let client: NeoClient;

function makeClient(): NeoClient {
  return {
    timeline: {
      offRecord: vi.fn(async () => {
        const entry = useTimeline.getState();
        return { active: entry.offRecord, episodeId: entry.offRecord ? 'ep_private' : null, startedAt: entry.offRecord ? 1000 : null };
      }),
      startOffRecord: vi.fn().mockResolvedValue({ active: true, episodeId: 'ep_private', startedAt: 1000 }),
      endOffRecord: vi.fn().mockResolvedValue({ active: false, episodeId: null, startedAt: null }),
      list: vi.fn(async () => {
        const entry = useTimeline.getState();
        return { items: entry.messages, episodes: Object.values(entry.episodes), nextCursor: null };
      }),
      deleteMessage: vi.fn(async (id: string) => ({ messageIds: [id], derivedMemories: 0 })),
      uiAction: vi.fn().mockResolvedValue({ kind: 'noop' }),
      send: vi.fn(),
      cancel: vi.fn().mockResolvedValue({ cancelled: true }),
    },
    confirmations: { respond: vi.fn().mockResolvedValue({ ok: true }) },
  } as unknown as NeoClient;
}

function readySession(url = 'https://server-a.example'): void {
  client = startSession({ serverUrl: url, token: 'draft-tests-owner' }, 'manual');
  useSession.setState({ phase: 'ready', settings: { ...DEFAULT_SETTINGS, onboarded: true, timezone: 'UTC' }, wsStatus: 'open',
    providers: { items: [{ id: 'local', kind: 'ollama', label: 'Local AI', enabled: true, defaultModel: 'model', hasApiKey: false, isLocal: true }], defaultModel: { provider: 'local', model: 'model' } } });
  useTimeline.setState({ ...emptyEntry(), loaded: true, offRecordLoaded: true }, true);
}

function workView(): UIBlock {
  return {
    type: 'tabs', id: 'dinner-work-view', tabs: [
      { id: 'plan', label: 'Plan', children: [{ type: 'form', id: 'details', title: 'Dinner details', fields: [
        { name: 'draft', kind: 'textarea', label: 'Draft invite', defaultValue: 'Hi Alex,' },
        { name: 'time', kind: 'select', label: 'Dinner time', defaultValue: '18:30', options: [{ value: '18:30', label: '6:30 PM' }, { value: '19:00', label: '7:00 PM' }] },
        { name: 'vegetarian', kind: 'checkbox', label: 'Vegetarian table', defaultValue: false },
      ], submitLabel: 'Use this plan' }] },
      { id: 'options', label: 'Options', children: [{ type: 'accordion', id: 'extras', items: [
        { id: 'notes', title: 'More details', children: [{ type: 'form', id: 'extra-details', title: 'Additional details', fields: [
          { name: 'notes', kind: 'text', label: 'Additional notes', defaultValue: '' },
        ] }] },
      ] }] },
    ],
  };
}

function message(id = 'msg_dinner', episodeId = 'ep_recorded'): Message {
  return { id, episodeId, conversationId: episodeId, role: 'assistant', status: 'complete', createdAt: 1000,
    parts: [{ type: 'ui', id: 'ui_dinner', block: workView() }] };
}

function seedMessages(messages: Message[], privateMode = false): void {
  useTimeline.setState((entry) => ({ ...entry, messages, loaded: true, offRecordLoaded: true, offRecord: privateMode,
    episodes: Object.fromEntries([...new Set(messages.map((m) => m.episodeId!))].map((id) => [id, { episodeId: id, startedAt: 1000, offRecord: id === 'ep_private', ephemeral: id === 'ep_private' }])) }));
}

/** Uses the real hash router; leaving the timeline destroys its component tree. */
function RoutedPages() {
  const route = useRoute();
  return route.name === 'timeline' ? <TimelineScreen messageId={route.messageId} /> : <h1>Tasks page</h1>;
}

function show() {
  return render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><RoutedPages /></ConfirmProvider></I18nProvider>);
}

function go(route: Parameters<typeof navigate>[0]): void {
  act(() => navigate(route, { replace: true }));
}

async function roundTrip(): Promise<void> {
  go({ name: 'tasks' });
  expect(screen.getByRole('heading', { name: 'Tasks page' })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Message NEO…' })).toBeNull();
  go({ name: 'timeline' });
  await screen.findByRole('textbox', { name: 'Message NEO…' });
}

function composer(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Message NEO…' }) as HTMLTextAreaElement;
}

function textField(name: string): HTMLInputElement | HTMLTextAreaElement {
  return screen.getByRole('textbox', { name }) as HTMLInputElement | HTMLTextAreaElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  resetChatDrafts();
  readySession();
  window.history.replaceState({}, '', '#/');
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe('chat drafts across app pages', () => {
  it('returns to the exact unsent composer text after visiting another page', async () => {
    show();
    const draft = 'Dinner with Alex\n还没有发送，保留这个草稿。';
    fireEvent.change(composer(), { target: { value: draft } });

    await roundTrip();

    expect(composer().value).toBe(draft);
    expect(client.timeline.send).not.toHaveBeenCalled();
    expect(client.timeline.uiAction).not.toHaveBeenCalled();
  });

  it('keeps edited fields through generated tabs, accordion collapse, and page navigation', async () => {
    seedMessages([message()]);
    show();
    fireEvent.change(textField('Draft invite'), { target: { value: 'Hi Alex, Thursday at Juniper?' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Dinner time' }), { target: { value: '19:00' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Vegetarian table' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Options' }));
    fireEvent.click(screen.getByRole('button', { name: 'More details' }));
    fireEvent.change(textField('Additional notes'), { target: { value: 'Keep a quiet table by the window.' } });
    fireEvent.click(screen.getByRole('button', { name: 'More details' }));
    expect(screen.queryByRole('textbox', { name: 'Additional notes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More details' }));
    expect(textField('Additional notes').value).toBe('Keep a quiet table by the window.');

    await roundTrip();

    expect(screen.getByRole('tab', { name: 'Options' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'More details' }).getAttribute('aria-expanded')).toBe('true');
    expect(textField('Additional notes').value).toBe('Keep a quiet table by the window.');
    fireEvent.click(screen.getByRole('tab', { name: 'Plan' }));
    expect(textField('Draft invite').value).toBe('Hi Alex, Thursday at Juniper?');
    expect((screen.getByRole('combobox', { name: 'Dinner time' }) as HTMLSelectElement).value).toBe('19:00');
    expect((screen.getByRole('checkbox', { name: 'Vegetarian table' }) as HTMLInputElement).checked).toBe(true);
    expect(client.timeline.uiAction).not.toHaveBeenCalled();
  });

  it('separates generated controls in different messages even when their UI and block IDs repeat', async () => {
    seedMessages([message('msg_first'), message('msg_second')]);
    show();
    const fields = screen.getAllByRole('textbox', { name: 'Draft invite' }) as HTMLTextAreaElement[];
    fireEvent.change(fields[0]!, { target: { value: 'First message edit' } });
    fireEvent.change(fields[1]!, { target: { value: 'Second message edit' } });

    await roundTrip();

    expect((screen.getAllByRole('textbox', { name: 'Draft invite' }) as HTMLTextAreaElement[]).map((field) => field.value)).toEqual(['First message edit', 'Second message edit']);
  });

  it('restores a failed send even when the user left the timeline before its response', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(client.timeline.send).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    show();
    fireEvent.change(composer(), { target: { value: 'Do not lose this request.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(client.timeline.send).toHaveBeenCalledTimes(1));
    go({ name: 'tasks' });
    await act(async () => reject(new Error('Offline before the request was accepted')));
    go({ name: 'timeline' });

    await waitFor(() => expect(composer().value).toBe('Do not lose this request.'));
  });
});

describe('chat draft cleanup and isolation', () => {
  it('clears composer and generated edits on a server switch, including reused message IDs', async () => {
    const original = message();
    seedMessages([original]);
    show();
    fireEvent.change(composer(), { target: { value: 'Only for server A' } });
    fireEvent.change(textField('Draft invite'), { target: { value: 'Server A private working text' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Options' }));
    fireEvent.click(screen.getByRole('button', { name: 'More details' }));

    await act(async () => { readySession('https://server-b.example'); seedMessages([original]); });

    expect(composer().value).toBe('');
    expect(screen.getByRole('tab', { name: 'Plan' }).getAttribute('aria-selected')).toBe('true');
    expect(textField('Draft invite').value).toBe('Hi Alex,');
    await act(async () => { readySession('https://server-a.example'); seedMessages([original]); });
    expect(composer().value).toBe('');
    expect(textField('Draft invite').value).toBe('Hi Alex,');
  });

  it('does not resurrect unsent text or generated edits after disconnecting and reconnecting', async () => {
    seedMessages([message()]);
    const view = show();
    fireEvent.change(composer(), { target: { value: 'A disconnected draft' } });
    fireEvent.change(textField('Draft invite'), { target: { value: 'A disconnected form edit' } });
    view.unmount();

    act(() => showConnect({ reason: 'manual' }));
    readySession();
    seedMessages([message()]);
    show();

    expect(composer().value).toBe('');
    expect(textField('Draft invite').value).toBe('Hi Alex,');
  });

  it('keeps recorded input separate and discards private input when off-record mode ends', async () => {
    show();
    fireEvent.change(composer(), { target: { value: 'My recorded draft' } });
    await act(async () => setOffRecord(client, true, t));
    expect(composer().value).toBe('');
    fireEvent.change(composer(), { target: { value: 'A private draft' } });
    act(() => seedMessages([message('msg_private', 'ep_private')], true));
    fireEvent.change(textField('Draft invite'), { target: { value: 'Private generated edit' } });

    await roundTrip();
    expect(composer().value).toBe('A private draft');
    expect(textField('Draft invite').value).toBe('Private generated edit');
    await act(async () => setOffRecord(client, false, t));
    expect(composer().value).toBe('My recorded draft');
    expect(screen.queryByRole('textbox', { name: 'Draft invite' })).toBeNull();

    await act(async () => setOffRecord(client, true, t));
    act(() => seedMessages([message('msg_private', 'ep_private')], true));
    expect(composer().value).toBe('');
    expect(textField('Draft invite').value).toBe('Hi Alex,');
  });

  it('rejects a late private-send restoration after that private session ended', async () => {
    show();
    await act(async () => setOffRecord(client, true, t));
    let reject!: (error: Error) => void;
    vi.mocked(client.timeline.send).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    fireEvent.change(composer(), { target: { value: 'The earlier private request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(client.timeline.send).toHaveBeenCalledTimes(1));
    go({ name: 'tasks' });
    // Another device can end privacy while this client still awaits acceptance.
    act(() => applyTimelineEvent({ type: 'timeline.off_record', active: false }));
    await act(async () => reject(new Error('The earlier private request failed')));
    await act(async () => setOffRecord(client, true, t));
    go({ name: 'timeline' });

    expect(composer().value).toBe('');
  });

  it('rejects a pending generated completion after its private working state was cleared', async () => {
    const original = message('msg_private', 'ep_private');
    seedMessages([original], true);
    let finish!: (result: { kind: 'noop' }) => void;
    vi.mocked(client.timeline.uiAction).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    show();
    fireEvent.change(textField('Draft invite'), { target: { value: 'Old private draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this plan' }));
    await waitFor(() => expect(client.timeline.uiAction).toHaveBeenCalledTimes(1));
    await act(async () => setOffRecord(client, false, t));
    await act(async () => setOffRecord(client, true, t));
    act(() => seedMessages([original], true));
    expect(textField('Draft invite').value).toBe('Hi Alex,');

    await act(async () => finish({ kind: 'noop' }));

    expect(textField('Draft invite').value).toBe('Hi Alex,');
    expect(screen.queryByText('Sent')).toBeNull();
    expect((screen.getByRole('button', { name: 'Use this plan' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('forgets the deleted message working state while keeping the composer draft', async () => {
    const original = message();
    seedMessages([original]);
    show();
    fireEvent.change(composer(), { target: { value: 'An unrelated next request' } });
    fireEvent.change(textField('Draft invite'), { target: { value: 'Deleted working text' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Options' }));
    fireEvent.click(screen.getByRole('button', { name: 'More details' }));

    await act(async () => { await deleteMessage(client, original.id, t, async () => true); });
    expect(screen.queryByRole('tab', { name: 'Options' })).toBeNull();
    act(() => seedMessages([original]));

    expect(composer().value).toBe('An unrelated next request');
    expect(screen.getByRole('tab', { name: 'Plan' }).getAttribute('aria-selected')).toBe('true');
    expect(textField('Draft invite').value).toBe('Hi Alex,');
  });
});
