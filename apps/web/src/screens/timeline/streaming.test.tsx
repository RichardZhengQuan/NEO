import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NeoClient } from '@neo/client';
import { DEFAULT_SETTINGS, MemoryNodeSchema, type ConfirmationDecision, type Message, type ToolConfirmation } from '@neo/protocol';
import { ConfirmProvider, I18nProvider } from '@neo/ui';
import type { ReactElement } from 'react';
import { appDictionaries } from '../../i18n.js';
import { navigate } from '../../router.js';
import { useData } from '../../state/data.js';
import { useToasts } from '../../state/notifications.js';
import { useSession } from '../../state/session.js';
import { applyTimelineEvent, emptyEntry, useTimeline } from '../../state/timeline.js';
import { useUi } from '../../state/ui.js';
import { TimelineScreen } from '../TimelineScreen.js';
import { MemoryDetail } from '../memory/MemoryDetail.js';

vi.mock('../../router.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../router.js')>(),
  navigate: vi.fn(),
}));

const scope = { episodeId: 'ep_1', conversationId: 'ep_1', turnId: 'turn_1' };
const user: Message = { id: 'message_user', ...scope, role: 'user', status: 'complete', createdAt: 1000, parts: [{ type: 'text', text: 'Hello NEO' }] };
const confirmation: ToolConfirmation = {
  id: 'cnf_single_use_nonce', ...scope, messageId: 'message_assistant', toolCallId: 'provider_call_id',
  name: 'delete_note', title: 'Delete note', input: { id: 'note_1' }, description: "Delete note 'Groceries'",
  risk: 'dangerous', requestedAt: 1000, expiresAt: Date.now() + 120000,
};
let client: NeoClient;

function show(child: ReactElement = <TimelineScreen />) {
  return render(<I18nProvider locale="en" messages={appDictionaries}><ConfirmProvider>{child}</ConfirmProvider></I18nProvider>);
}

function startTurn() {
  applyTimelineEvent({ type: 'turn.started', ...scope, userMessage: user, assistantMessageId: 'message_assistant', model: { provider: 'local', model: 'model' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  client = {
    timeline: { offRecord: vi.fn().mockResolvedValue({ active: false, episodeId: null, startedAt: null }), startOffRecord: vi.fn().mockResolvedValue({ active: true, episodeId: null, startedAt: 1 }), list: vi.fn(), uiAction: vi.fn().mockResolvedValue({ kind: 'noop' }), cancel: vi.fn().mockResolvedValue({ ok: true }) },
    confirmations: { respond: vi.fn().mockResolvedValue({ ok: true }) },
    memory: { get: vi.fn() },
  } as unknown as NeoClient;
  useSession.setState((s) => ({ client, serverUrl: 'http://neo.local', sessionEpoch: s.sessionEpoch + 1, wsStatus: 'open',
    settings: { ...DEFAULT_SETTINGS, timezone: 'UTC' },
    providers: { items: [{ id: 'local', kind: 'ollama', label: 'Local AI', enabled: true, defaultModel: 'model', hasApiKey: false, isLocal: true }], defaultModel: { provider: 'local', model: 'model' } } }));
  useTimeline.setState({ ...emptyEntry(), loaded: true }, true);
  useData.setState({ memoryVersion: 0, reminders: {}, tasks: {} });
  useToasts.setState({ toasts: [] });
  useUi.setState({ timelineSearchRequested: 0 });
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('timeline retains live message behavior', () => {
  it('renders streamed deltas and settles the live indicator when the turn finishes', () => {
    startTurn();
    const view = show();
    expect(screen.getByRole('status', { name: 'Thinking…' })).toBeTruthy();
    expect(screen.getByRole('log').getAttribute('aria-busy')).toBe('true');
    act(() => {
      applyTimelineEvent({ type: 'text.delta', ...scope, messageId: 'message_assistant', text: 'Hello ' });
      applyTimelineEvent({ type: 'text.delta', ...scope, messageId: 'message_assistant', text: 'again' });
    });
    expect(screen.getByText('Hello again')).toBeTruthy();
    expect(view.container.querySelector('.neo-caret')).toBeTruthy();
    act(() => applyTimelineEvent({ type: 'turn.finished', ...scope, stopReason: 'end', usage: { inputTokens: 5, outputTokens: 2 } }));
    expect(screen.getByText('Hello again')).toBeTruthy();
    expect(view.container.querySelector('.neo-caret')).toBeNull();
    expect(screen.getByRole('log').getAttribute('aria-busy')).toBeNull();
    expect(useTimeline.getState().messages.at(-1)?.status).toBe('complete');
    expect(client.timeline.list).not.toHaveBeenCalled();
  });

  it.each<[string, ConfirmationDecision]>([
    ['Allow', { approve: true }],
    ['Always allow', { approve: true, always: true }],
    ['Deny', { approve: false }],
  ])('answers %s by the server confirmation nonce and removes the card', async (label, decision) => {
    startTurn();
    applyTimelineEvent({ type: 'part.added', ...scope, messageId: 'message_assistant', index: 0, part: { type: 'tool_call', id: 'provider_call_id', name: 'delete_note', input: { id: 'note_1' } } });
    applyTimelineEvent({ type: 'tool.confirmation', ...scope, confirmation });
    show();
    expect(screen.getByText("Delete note 'Groceries'")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(client.confirmations.respond).toHaveBeenCalledWith('cnf_single_use_nonce', decision));
    await waitFor(() => expect(screen.queryByText("Delete note 'Groceries'")).toBeNull());
    expect(useTimeline.getState().confirmations).toEqual([]);
    expect(client.confirmations.respond).toHaveBeenCalledTimes(1);
  });

  it('routes a generated UI button with its persisted message and UI part ids', async () => {
    startTurn();
    applyTimelineEvent({ type: 'part.added', ...scope, messageId: 'message_assistant', index: 0,
      part: { type: 'ui', id: 'ui_options', block: { type: 'buttons', actions: [{ id: 'suggest_walk', kind: 'message', label: 'Plan a walk', text: 'Help me plan a walk' }] } } });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Plan a walk' }));
    await waitFor(() => expect(client.timeline.uiAction).toHaveBeenCalledWith({ messageId: 'message_assistant', uiId: 'ui_options', actionId: 'suggest_walk' }));
    expect(client.timeline.uiAction).toHaveBeenCalledTimes(1);
  });

  it('shows recalled-memory chips during a live turn and opens the selected memory', () => {
    startTurn();
    show();
    act(() => applyTimelineEvent({ type: 'memory.recalled', ...scope, items: [{ id: 'mem_preference', kind: 'preference', label: 'Likes coffee', score: 0.9, reason: 'Relevant to your request' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Recalled 1 memory' }));
    expect(screen.getByText('Relevant to your request')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Likes coffee' }));
    expect(navigate).toHaveBeenCalledWith({ name: 'memory', tab: 'net', nodeId: 'mem_preference' });
  });

  it('recovers recalled memories from stored hidden context without exposing that context', () => {
    const context = '<neo_context>\nnow: 2026-10-12 10:00 Monday (UTC)\nmemories:\n- [fact] Prefers short walks (id mem_walk)\n</neo_context>';
    useTimeline.setState({ messages: [
      { ...user, parts: [{ type: 'context', text: context }, { type: 'text', text: 'Suggest an activity' }] },
      { id: 'message_assistant', ...scope, role: 'assistant', parts: [{ type: 'text', text: 'Try a short walk.' }], createdAt: 2000, status: 'complete' },
    ] });
    show();
    expect(screen.queryByText(/neo_context|now: 2026/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Recalled 1 memory' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prefers short walks' }));
    expect(navigate).toHaveBeenCalledWith({ name: 'memory', tab: 'net', nodeId: 'mem_walk' });
  });

  it('keeps remembered notices below the assistant response and opens their memory', () => {
    startTurn();
    show();
    act(() => {
      applyTimelineEvent({ type: 'text.delta', ...scope, messageId: 'message_assistant', text: 'I will remember that.' });
      applyTimelineEvent({ type: 'memory.written', ...scope, created: [
        { id: 'mem_written', kind: 'preference', label: 'Prefers morning walks', status: 'active' },
        { id: 'mem_episode', kind: 'episode', label: 'Internal episode summary', status: 'active' },
      ], updated: [] });
      applyTimelineEvent({ type: 'turn.finished', ...scope, stopReason: 'end', usage: null });
    });
    expect(screen.getByText('Remembered: Prefers morning walks')).toBeTruthy();
    expect(screen.queryByText(/Internal episode summary/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(navigate).toHaveBeenCalledWith({ name: 'memory', tab: 'net', nodeId: 'mem_written' });
    act(() => applyTimelineEvent({ type: 'memory.written', ...scope, created: [], updated: [{ id: 'mem_written', kind: 'preference', label: 'Morning and evening walks', status: 'active' }] }));
    expect(screen.getByText('Updated: Morning and evening walks')).toBeTruthy();
  });

  it('opens a memory source at its timeline message id', async () => {
    const node = MemoryNodeSchema.parse({ id: 'mem_source', kind: 'fact', label: 'Source fact', content: 'A fact from a timeline message.',
      importance: 0.5, confidence: 0.9, stability: 30, accessCount: 0, lastAccessedAt: null, createdAt: 1000, updatedAt: 1000,
      status: 'active', pinned: false, sensitivity: 'normal', source: { by: 'extraction', conversationId: 'ep_1', messageId: 'msg_source-1' } });
    vi.mocked(client.memory.get).mockResolvedValueOnce({ node, retention: 1, edges: [], neighbors: [], history: [] });
    show(<MemoryDetail nodeId={node.id} onClose={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open source message' }));
    expect(client.memory.get).toHaveBeenCalledWith('mem_source');
    expect(navigate).toHaveBeenCalledWith({ name: 'timeline', messageId: 'msg_source-1' });
  });
});
