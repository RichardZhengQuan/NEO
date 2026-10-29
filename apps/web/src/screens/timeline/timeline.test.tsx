import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { NeoClient } from '@neo/client';
import { DEFAULT_SETTINGS, type Message, type TimelinePage, type TimelineSearchHit } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import { appDictionaries } from '../../i18n.js';
import { useSession } from '../../state/session.js';
import { applyTimelineEvent, emptyEntry, resetTimeline, useTimeline } from '../../state/timeline.js';
import { useUi } from '../../state/ui.js';
import { TimelineScreen } from '../TimelineScreen.js';

const now = Date.now();
const message = (id: string, at = now, episodeId = 'ep_1'): Message & { episodeId: string } => ({ id, episodeId, conversationId: episodeId, role: 'user', parts: [{ type: 'text', text: id }], status: 'complete', createdAt: at });
const page = (items: ReturnType<typeof message>[], nextCursor: string | null = null): TimelinePage => ({ items, nextCursor, episodes: [] });
let client: NeoClient;
const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; });
const scrollIntoView = vi.fn();

function show() {
  return render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider><TimelineScreen /></ConfirmProvider></I18nProvider>);
}
function row(id: string) { return document.querySelector<HTMLElement>(`[data-timeline-message="${id}"]`)!; }

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  client = { timeline: { offRecord: vi.fn().mockResolvedValue({ active: false, episodeId: null, startedAt: null }), startOffRecord: vi.fn().mockResolvedValue({ active: true, episodeId: null, startedAt: 1 }), list: vi.fn().mockResolvedValue(page([])), search: vi.fn().mockResolvedValue({ items: [] }), send: vi.fn(), endOffRecord: vi.fn().mockResolvedValue({ deleted: 1 }), deleteMessage: vi.fn().mockResolvedValue({ deleted: 1, messageIds: ['delete-me'], derivedMemories: 2 }) }, memory: { forgetBySource: vi.fn().mockResolvedValue({ deleted: 2 }) } } as unknown as NeoClient;
  useSession.setState({ client, serverUrl: 'http://neo.local', wsStatus: 'open', settings: { ...DEFAULT_SETTINGS, timezone: 'UTC' }, providers: { items: [{ id: 'local', kind: 'ollama', label: 'Local', enabled: true, defaultModel: 'model', isLocal: true, hasApiKey: false }], defaultModel: { provider: 'local', model: 'model' } } });
  resetTimeline('http://neo.local');
  useTimeline.setState({ loaded: true, offRecordLoaded: true });
  useUi.setState({ timelineSearchRequested: 0 });
  HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width'), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('continuous timeline', () => {
  it('renders day and actual episode boundaries without titles or a model picker', () => {
    const today = Date.now();
    const yesterday = today - 86400000;
    const older = today - 3 * 86400000;
    useTimeline.setState({ messages: [message('past', older, 'ep_past'), message('yesterday', yesterday), message('today', today, 'ep_today')], episodes: {
      ep_past: { episodeId: 'ep_past', startedAt: older, offRecord: false, firstMessageId: 'past' },
      ep_1: { episodeId: 'ep_1', startedAt: yesterday, offRecord: false, firstMessageId: 'yesterday' },
      ep_today: { episodeId: 'ep_today', startedAt: today, offRecord: false, firstMessageId: 'today' },
    } });
    show();
    expect(screen.getByRole('separator', { name: 'Today' })).toBeTruthy();
    expect(screen.getByRole('separator', { name: 'Yesterday' })).toBeTruthy();
    expect(screen.getAllByRole('separator', { name: /Episode starting at/ })).toHaveLength(3);
    expect(screen.getAllByRole('separator')).toHaveLength(6);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/New chat|Untitled|Archive|Pin/)).toBeNull();
  });

  it('omits an episode marker for a page starting in the middle of an episode', () => {
    useTimeline.setState({ messages: [message('middle')], episodes: { ep_1: { episodeId: 'ep_1', startedAt: now - 60000, offRecord: false } } });
    show();
    expect(screen.queryByRole('separator', { name: /Episode starting at/ })).toBeNull();
  });

  it('opens at the newest message and automatically prepends a cursor page without moving the viewport', async () => {
    useTimeline.setState({ loaded: false });
    vi.mocked(client.timeline.list).mockResolvedValueOnce(page([message('newest')], 'opaque-cursor'));
    const view = show();
    await screen.findByText('newest');
    const scroller = screen.getByTestId('timeline-scroll');
    let height = 1000;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    expect(scrollTo).toHaveBeenCalled();
    let resolve!: (value: TimelinePage) => void;
    vi.mocked(client.timeline.list).mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    scroller.scrollTop = 20;
    fireEvent.scroll(scroller);
    fireEvent.scroll(scroller);
    expect(client.timeline.list).toHaveBeenLastCalledWith({ limit: 50, before: 'opaque-cursor' });
    expect(client.timeline.list).toHaveBeenCalledTimes(2);
    await act(async () => { height = 1500; resolve(page([message('older', now - 10000)])); });
    expect(scroller.scrollTop).toBe(520);
    expect(view.container.textContent!.indexOf('older')).toBeLessThan(view.container.textContent!.indexOf('newest'));
    expect(useTimeline.getState().nextCursor).toBeNull();
  });

  it('offers recovery after an initial timeline load fails', async () => {
    useTimeline.setState({ loaded: false });
    vi.mocked(client.timeline.list).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([message('recovered')]));
    show();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('recovered')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('searches, loads around a result, scrolls to it and briefly highlights it', async () => {
    vi.useFakeTimers();
    useTimeline.setState({ messages: [message('newest')] });
    vi.mocked(client.timeline.search).mockResolvedValue({ items: [{ messageId: 'found', episodeId: 'ep_1', snippet: { text: 'A saved thought', highlights: [[8, 15]] }, createdAt: now - 1000 }] });
    vi.mocked(client.timeline.list).mockResolvedValue(page([message('found'), message('after')]));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Search timeline' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search messages' }), { target: { value: 'thought' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(client.timeline.search).toHaveBeenCalledWith('thought', 50);
    const result = screen.getByRole('button', { name: /A saved thought/ });
    expect(result.querySelector('mark')?.textContent).toBe('thought');
    expect(result.querySelector('time')).toBeTruthy();
    await act(async () => { fireEvent.click(result); });
    expect(client.timeline.list).toHaveBeenCalledWith({ limit: 100, around: 'found' });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    expect(row('found').dataset.highlight).toBe('true');
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(row('found').dataset.highlight).toBeUndefined();
  });

  it('ignores a search response for a previous query', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { items: TimelineSearchHit[] }) => void;
    vi.mocked(client.timeline.search).mockImplementationOnce(() => new Promise((yes) => { resolve = yes; })).mockResolvedValueOnce({ items: [] });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Search timeline' }));
    const field = screen.getByRole('searchbox');
    fireEvent.change(field, { target: { value: 'old' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.change(field, { target: { value: 'new' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); resolve({ items: [{ messageId: 'stale', episodeId: 'ep_1', snippet: { text: 'Stale hit', highlights: [] }, createdAt: now }] }); });
    expect(screen.queryByText('Stale hit')).toBeNull();
    expect(screen.getByText('No matching messages.')).toBeTruthy();
  });

  it('highlights only match ranges while keeping brackets, Unicode and HTML as literal text', async () => {
    vi.useFakeTimers();
    const text = '🙂 Prefer [brackets], window seats and <b>window</b>.';
    vi.mocked(client.timeline.search).mockResolvedValue({ items: [{
      messageId: 'bracketed', episodeId: 'ep_1', createdAt: now,
      snippet: { text, highlights: [[22, 28], [29, 34], [42, 48]] },
    }] });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Search timeline' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'window seats' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    const result = screen.getByRole('button', { name: /Prefer \[brackets\]/ });
    expect(result.querySelector('span')?.textContent).toBe(text);
    expect([...result.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['window', 'seats', 'window']);
    expect(result.querySelector('b')).toBeNull();
    expect(result.textContent).not.toMatch(/[\uE000\uE001]/);
  });

  it('jumps to local midnight on the selected date', async () => {
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, timezone: 'Asia/Singapore' } });
    vi.mocked(client.timeline.list).mockResolvedValue(page([message('dated', Date.parse('2026-10-02T03:00:00Z'))]));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Jump to date' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    await waitFor(() => expect(client.timeline.list).toHaveBeenCalledWith({ limit: 100, around: '2026-10-01T16:00:00.000Z' }));
    await waitFor(() => expect(row('dated').dataset.highlight).toBe('true'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('turns privacy on with distinct styling, persists it, then erases private messages when ended', async () => {
    useTimeline.setState({ messages: [message('kept')] });
    vi.mocked(client.timeline.list).mockResolvedValue(page([message('kept')]));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Off the record' }));
    await waitFor(() => expect(useTimeline.getState().offRecord).toBe(true));
    expect(client.timeline.startOffRecord).toHaveBeenCalledOnce();
    expect(screen.getByText('Off the record — not remembered, and erased when you turn this off.')).toBeTruthy();
    expect(document.querySelector('.chat-dock')!.getAttribute('data-off-record')).toBe('true');
    await act(async () => { useTimeline.setState((state) => ({ messages: [...state.messages, message('private', now, 'ep_private')], episodes: { ...state.episodes, ep_private: { episodeId: 'ep_private', startedAt: now, offRecord: true, ephemeral: true, firstMessageId: 'private' } } })); });
    expect(row('private').dataset.offRecord).toBe('true');
    expect(row('kept').dataset.offRecord).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Off the record' }));
    await waitFor(() => expect(client.timeline.endOffRecord).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('private')).toBeNull());
    expect(screen.getByText('kept')).toBeTruthy();
    expect(useTimeline.getState().offRecord).toBe(false);
    expect(sessionStorage.getItem('neo.timeline.off-record:http://neo.local')).toBeNull();
  });

  it('restores the off-record toggle on reload and keeps it on when ending fails', async () => {
    sessionStorage.setItem('neo.timeline.off-record:http://neo.local', JSON.stringify({ active: true, episodes: ['ep_private'] }));
    resetTimeline('http://neo.local');
    useTimeline.setState({ loaded: true, messages: [message('private', now, 'ep_private')] });
    vi.mocked(client.timeline.offRecord).mockResolvedValue({ active: true, episodeId: 'ep_private', startedAt: now });
    vi.mocked(client.timeline.endOffRecord).mockRejectedValue(new Error('offline'));
    show();
    await waitFor(() => expect(useTimeline.getState().offRecordLoaded).toBe(true));
    expect(screen.getByRole('button', { name: 'Off the record' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Off the record' }));
    await waitFor(() => expect(client.timeline.endOffRecord).toHaveBeenCalled());
    await waitFor(() => expect(useTimeline.getState().endingOffRecord).toBe(false));
    expect(useTimeline.getState().offRecord).toBe(true);
    expect(screen.getByText('private')).toBeTruthy();
  });

  it('confirms message deletion then offers to forget derived memories', async () => {
    useTimeline.setState({ messages: [message('delete-me')] });
    show();
    fireEvent.click(within(row('delete-me')).getByRole('button', { name: 'Message options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this message?' });
    expect(client.timeline.deleteMessage).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const forget = await screen.findByRole('dialog', { name: 'Also forget these memories?' });
    expect(screen.queryByText('delete-me')).toBeNull();
    fireEvent.click(within(forget).getByRole('button', { name: 'Also forget 2 memories' }));
    await waitFor(() => expect(client.memory.forgetBySource).toHaveBeenCalledWith(['delete-me']));
  });

  it('cancels a message deletion without changing the transcript', async () => {
    useTimeline.setState({ messages: [message('delete-me')] });
    show();
    fireEvent.click(within(row('delete-me')).getByRole('button', { name: 'Message options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(client.timeline.deleteMessage).not.toHaveBeenCalled();
    expect(screen.getByText('delete-me')).toBeTruthy();
  });

  it('puts search and date actions in one phone header menu', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    show();
    expect(screen.queryByRole('button', { name: 'Search timeline' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Timeline options' }));
    expect(screen.getByRole('menuitem', { name: 'Search timeline' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Jump to date' })).toBeTruthy();
  });

  it('opens a shortcut-requested search once, including when entering from another screen', async () => {
    useUi.setState({ timelineSearchRequested: 1 });
    const view = show();
    expect(screen.getByRole('dialog', { name: 'Search timeline' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    view.unmount();
    show();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});


it('replaces a stale cached toggle with server state and follows another device', async () => {
  sessionStorage.setItem('neo.timeline.off-record:http://neo.local', JSON.stringify({ active: true, episodes: [] }));
  resetTimeline('http://neo.local');
  useTimeline.setState({ loaded: true });
  show();
  expect((screen.getByRole('button', { name: 'Off the record' }) as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Off the record' }).getAttribute('aria-pressed')).toBe('false'));
  expect(sessionStorage.getItem('neo.timeline.off-record:http://neo.local')).toBeNull();
  act(() => applyTimelineEvent({ type: 'timeline.off_record', active: true }));
  expect(screen.getByRole('button', { name: 'Off the record' }).getAttribute('aria-pressed')).toBe('true');
  act(() => applyTimelineEvent({ type: 'timeline.off_record', active: false }));
  expect(screen.getByRole('button', { name: 'Off the record' }).getAttribute('aria-pressed')).toBe('false');
});

it('keeps the toggle off when the server rejects entering privacy', async () => {
  vi.mocked(client.timeline.startOffRecord).mockRejectedValue(new Error('offline'));
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Off the record' }));
  await waitFor(() => expect(client.timeline.startOffRecord).toHaveBeenCalledOnce());
  await waitFor(() => expect(useTimeline.getState().startingOffRecord).toBe(false));
  expect(screen.getByRole('button', { name: 'Off the record' }).getAttribute('aria-pressed')).toBe('false');
  expect(screen.queryByText('Off the record — not remembered, and erased when you turn this off.')).toBeNull();
});


it('renders stored timeline UI in the current session timezone across the device date boundary', async () => {
  const NativeDateTimeFormat = Intl.DateTimeFormat;
  const device = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locale, options) {
      return new NativeDateTimeFormat(locale, { ...options, timeZone: options?.timeZone ?? 'Asia/Singapore' });
    });
  try {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Singapore');
    const instant = Date.parse('2026-10-29T01:30:00Z');
    const stored: Message = { ...message('zoned', instant), role: 'assistant', parts: [
      { type: 'ui', id: 'ui_legacy', block: { type: 'card', children: [{ type: 'timeline', items: [{ time: instant, title: 'Session time' }, { time: 0, title: 'Epoch' }, { time: 'Tomorrow morning', title: 'Literal' }] }] } },
      { type: 'ui', id: 'ui_explicit', block: { type: 'timeline', timezone: 'Asia/Tokyo', items: [{ time: instant, title: 'Explicit time' }] } },
    ] };
    useSession.setState({ settings: { ...DEFAULT_SETTINGS, timezone: 'America/New_York' } });
    useTimeline.setState({ messages: [stored] });
    const view = show();
    const times = () => Array.from(view.container.querySelectorAll('.neo-timeline__time'), (node) => node.textContent);
    expect(times()).toEqual(['Oct 28, 2026, 9:30 PM', 'Dec 31, 1969, 7:00 PM', 'Tomorrow morning', 'Oct 29, 2026, 10:30 AM']);
    await act(async () => { useSession.setState({ settings: { ...DEFAULT_SETTINGS, timezone: 'UTC' } }); });
    expect(times()).toEqual(['Oct 29, 2026, 1:30 AM', 'Jan 1, 1970, 12:00 AM', 'Tomorrow morning', 'Oct 29, 2026, 10:30 AM']);
    expect(useTimeline.getState().messages[0]).toBe(stored);
  } finally {
    device.mockRestore();
  }
});
