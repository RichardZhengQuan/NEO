/**
 * UI actions that need approval (security audit NEO-16) and tool confirmations
 * answered by their server nonce (NEO-04).
 *
 * Also includes F09 composeBody tests: text+image submissions must include
 * both the text and the image in the parts array sent to the server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoClient } from '@neo/client';
import { DEFAULT_SETTINGS, applySettingsPatch } from '@neo/protocol';
import type { ImagePart, Message, SendMessageRequest, ToolConfirmation, UIAction, UiActionConfirmation, UiActionRequest, UiActionResponse } from '@neo/protocol';
import { buildMessages, createTranslator } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { applyTimelineEvent, emptyEntry, resetTimeline, useTimeline } from '../state/timeline.js';
import { startSession, useSession } from '../state/session.js';
import { useToasts } from '../state/notifications.js';
import { applyTurnResponse, composeBody, retryTurn, sendMessage, cancelTurn, endTimelineOffRecord, setOffRecord, deleteMessage, deleteRange, respondToConfirmation, runUiAction, UiActionCancelled } from './timeline.js';

const t = createTranslator('en', buildMessages('en', appDictionaries));

const action: UIAction = { id: 'del', kind: 'tool', tool: 'delete_note', label: 'Tidy up', input: { id: 'note_1' }, confirm: 'Nothing will be deleted' };
const input = { messageId: 'msg_1', uiId: 'ui_1', action };
const confirmation = (token: string): UiActionConfirmation => ({
  token,
  tool: 'delete_note',
  title: 'Delete note',
  description: "Delete note 'Groceries'",
  risk: 'dangerous',
  expiresAt: 1_900_000_000_000,
});
const done: UiActionResponse = { kind: 'tool', output: null, isError: false, summary: 'Deleted' };

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { httpStatus: status, code: status === 409 ? 'conflict' : 'invalid_request' });
}

function fakeClient(responses: (UiActionResponse | Error)[]) {
  const uiAction = vi.fn(async (_body: UiActionRequest): Promise<UiActionResponse> => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
  const respond = vi.fn(async () => ({ ok: true }));
  return { client: { timeline: { uiAction }, confirmations: { respond } } as unknown as NeoClient, uiAction, respond };
}

beforeEach(() => {
  useTimeline.setState(emptyEntry(), true);
  sessionStorage.clear();
  useToasts.setState({ toasts: [] });
});

describe('runUiAction with server confirmation', () => {
  it('shows only the server confirmation, then resends the same request with the token', async () => {
    const { client, uiAction } = fakeClient([{ kind: 'confirm', confirmation: confirmation('tok_1') }, done]);
    const ask = vi.fn(async () => true);
    await runUiAction(client, input, t, ask);
    expect(ask).toHaveBeenCalledWith(confirmation('tok_1'));
    expect(uiAction).toHaveBeenCalledTimes(2);
    expect(uiAction.mock.calls[0]![0]).toEqual({ messageId: 'msg_1', uiId: 'ui_1', actionId: 'del' });
    expect(uiAction.mock.calls[1]![0]).toEqual({ messageId: 'msg_1', uiId: 'ui_1', actionId: 'del', confirmationToken: 'tok_1' });
    expect(useToasts.getState().toasts[0]!.title).toBe('Deleted');
  });

  it('cancel sends nothing more and rejects quietly', async () => {
    const { client, uiAction } = fakeClient([{ kind: 'confirm', confirmation: confirmation('tok_1') }]);
    await expect(runUiAction(client, input, t, async () => false)).rejects.toBeInstanceOf(UiActionCancelled);
    expect(uiAction).toHaveBeenCalledTimes(1);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('without a way to ask, a confirm response is treated as declined', async () => {
    const { client, uiAction } = fakeClient([{ kind: 'confirm', confirmation: confirmation('tok_1') }]);
    await expect(runUiAction(client, input, t)).rejects.toBeInstanceOf(UiActionCancelled);
    expect(uiAction).toHaveBeenCalledTimes(1);
  });

  it.each([400, 409])('an expired or invalid token (%i) gets a toast and one fresh attempt', async (status) => {
    const { client, uiAction } = fakeClient([{ kind: 'confirm', confirmation: confirmation('tok_1') }, httpError(status), { kind: 'confirm', confirmation: confirmation('tok_2') }, done]);
    const ask = vi.fn(async () => true);
    await runUiAction(client, input, t, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(uiAction.mock.calls.map((c) => c[0].confirmationToken)).toEqual([undefined, 'tok_1', undefined, 'tok_2']);
    expect(useToasts.getState().toasts.map((x) => x.title)).toContain('That approval expired. Please check it again.');
  });

  it('gives up after the fresh attempt also fails', async () => {
    const { client, uiAction } = fakeClient([
      { kind: 'confirm', confirmation: confirmation('tok_1') },
      httpError(409),
      { kind: 'confirm', confirmation: confirmation('tok_2') },
      httpError(409),
    ]);
    await expect(runUiAction(client, input, t, async () => true)).rejects.toThrow('HTTP 409');
    expect(uiAction).toHaveBeenCalledTimes(4);
  });

  it('actions that need no approval run in one request', async () => {
    const { client, uiAction } = fakeClient([done]);
    const ask = vi.fn(async () => true);
    await runUiAction(client, input, t, ask);
    expect(ask).not.toHaveBeenCalled();
    expect(uiAction).toHaveBeenCalledTimes(1);
  });
});

// ── F09: composeBody ─────────────────────────────────────────────────────────

const img: ImagePart = { type: 'image', mediaType: 'image/png', data: 'base64abc' };

describe('composeBody (F09)', () => {
  it('text-only: uses body.text, no parts array', () => {
    const body = composeBody('Hello', []);
    expect(body).toEqual({ text: 'Hello' });
    expect(body).not.toHaveProperty('parts');
  });

  it('empty text: returns empty body', () => {
    const body = composeBody('   ', []);
    expect(body).toEqual({});
  });

  it('image-only: parts contains only the image, no text part', () => {
    const body = composeBody('', [img]);
    expect(body).not.toHaveProperty('text');
    expect(body.parts).toEqual([img]);
  });

  it('text+image: parts contains a text part followed by the image (F09 repro)', () => {
    const body = composeBody('Describe this', [img]);
    expect(body).not.toHaveProperty('text');
    expect(body.parts).toEqual([
      { type: 'text', text: 'Describe this' },
      img,
    ]);
  });

  it('whitespace-only text with image: omits the text part', () => {
    const body = composeBody('   ', [img]);
    expect(body.parts).toEqual([img]);
  });
});

// ── respondToConfirmation ─────────────────────────────────────────────────────

describe('respondToConfirmation', () => {
  it('answers with the confirmation id (never the tool call id) and clears it locally', async () => {
    const pending: ToolConfirmation = {
      id: 'cnf_abc',
      episodeId: 'conv_1', conversationId: 'conv_1',
      turnId: 'turn_1',
      messageId: 'msg_1',
      toolCallId: 'tc_1',
      name: 'delete_note',
      title: 'Delete note',
      input: {},
      description: 'Delete note',
      risk: 'dangerous',
      requestedAt: 0,
      expiresAt: 1,
    };
    useTimeline.setState({
      confirmations: [pending],
    });
    const { client, respond } = fakeClient([]);
    await respondToConfirmation(client, 'cnf_abc', { approve: true }, t);
    expect(respond).toHaveBeenCalledWith('cnf_abc', { approve: true });
    expect(useTimeline.getState().confirmations).toHaveLength(0);
  });
});



function retryMessages(parts: Message['parts']): Message {
  const user: Message = { id: 'user_1', episodeId: 'conv_1', conversationId: 'conv_1', role: 'user', parts, createdAt: 1, status: 'complete' };
  const assistant: Message = { id: 'assistant_1', episodeId: 'conv_1', conversationId: 'conv_1', role: 'assistant', parts: [], createdAt: 2, status: 'error' };
  useTimeline.setState({ messages: [user, assistant] });
  return assistant;
}

describe('retryTurn preserves composed input (F09)', () => {
  it.each([
    { name: 'text-only', parts: [{ type: 'text', text: 'Question' }], expected: { text: 'Question' } },
    { name: 'image-only', parts: [img], expected: { parts: [img] } },
    { name: 'text and multiple images', parts: [{ type: 'text', text: 'Question' }, img, { ...img, data: 'second-image' }], expected: { parts: [{ type: 'text', text: 'Question' }, img, { ...img, data: 'second-image' }] } },
  ] satisfies { name: string; parts: Message['parts']; expected: SendMessageRequest }[])('$name retries reuse every user text/image part without context', async ({ parts, expected }) => {
    const assistant = retryMessages([{ type: 'context', text: 'Per-turn private context', sensitive: true }, ...parts]);
    const stream = vi.fn(async function* () {});
    const client = { timeline: { stream } } as unknown as NeoClient;
    useSession.setState({ wsStatus: 'idle' });
    await retryTurn(client, assistant, t);
    expect(stream).toHaveBeenCalledWith(expected, expect.any(AbortSignal));
  });
});

describe('HTTP turn model assignment', () => {
  it('uses Text capability before the legacy default-model alias', () => {
    const text = { provider: 'connected-ai', model: 'chosen-text' };
    const settings = applySettingsPatch(DEFAULT_SETTINGS, { ai: { capabilities: { text } } });
    useSession.setState({ settings: { ...settings, defaultModel: { provider: 'old-ai', model: 'old-text' } } });
    applyTurnResponse( { turnId: 'turn_text', assistantMessageId: 'assistant_text', userMessage: { id: 'user_text', episodeId: 'conv_text', conversationId: 'conv_text', role: 'user', parts: [{ type: 'text', text: 'Hello' }], status: 'complete', createdAt: 1 } });
    expect(useTimeline.getState().turn?.model).toEqual(text);
  });
});

describe('timeline responses are scoped to their session', () => {
  it('ignores a late timeline send response after switching servers', async () => {
    let resolveSend!: (response: unknown) => void;
    const client = { timeline: { send: vi.fn(() => new Promise((resolve) => { resolveSend = resolve; })) } } as unknown as NeoClient;
    useSession.setState({ wsStatus: 'open' });
    const send = sendMessage(client, { text: 'Hello' }, t);
    useSession.setState((s) => ({ sessionEpoch: s.sessionEpoch + 1 }));
    resolveSend({ episodeId: 'ep', turnId: 'old_turn', assistantMessageId: 'old_assistant', userMessage: { id: 'old_user', role: 'user', parts: [], conversationId: 'ep', createdAt: 1, status: 'complete' } });
    await send;
    expect(useTimeline.getState().messages).toEqual([]);
  });

  it('ignores a late SSE event after switching servers', async () => {
    let resolveEvent!: () => void;
    const waiting = new Promise<void>((resolve) => { resolveEvent = resolve; });
    let done!: () => void;
    const finished = new Promise<void>((resolve) => { done = resolve; });
    let signal: AbortSignal | undefined;
    const client = { timeline: { stream: async function* (_body: SendMessageRequest, abortSignal?: AbortSignal) {
      signal = abortSignal;
      try {
        await waiting;
        yield { type: 'text.delta' as const, episodeId: 'conv_old', conversationId: 'conv_old', turnId: 'old_turn', messageId: 'old_message', text: 'Old server text' };
      } finally { done(); }
    } } } as unknown as NeoClient;
    useSession.setState({ wsStatus: 'idle' });
    const sending = sendMessage(client, { text: 'Hello' }, t);
    startSession({ serverUrl: 'https://new.example', token: 'token' }, 'manual');
    expect(signal?.aborted).toBe(true);
    resolveEvent();
    await finished;
    await sending;
    expect(useTimeline.getState().messages).toEqual([]);
  });
});

describe('no provider send guidance', () => {
  it.each(['open', 'idle'] as const)('shows AI settings guidance for %s sends rejected with no_provider', async (wsStatus) => {
    const error = Object.assign(new Error('No usable provider'), { code: 'no_provider', httpStatus: 400 });
    const client = { timeline: {
      send: vi.fn(async () => { throw error; }),
      stream: vi.fn(async function* () { throw error; }),
    } } as unknown as NeoClient;
    useSession.setState({ wsStatus });

    await expect(sendMessage(client, { text: 'Hello' }, t)).rejects.toBe(error);
    await vi.waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));

    const toast = useToasts.getState().toasts[0]!;
    expect(toast.title).toBe('Connect an AI to start chatting');
    expect(toast.actions![0]!.label).toBe('Open AI settings');
    toast.actions![0]!.onClick();
    expect(window.location.hash).toBe('#/settings/ai');
    expect(useTimeline.getState().messages).toEqual([]);
  });
});


describe('timeline privacy transitions', () => {
  it('waits for explicit off-record deletion before a normal send', async () => {
    let finish!: () => void;
    const response = { episodeId: 'normal', turnId: 't', assistantMessageId: 'a', userMessage: { id: 'u', episodeId: 'normal', conversationId: 'normal', role: 'user', parts: [], createdAt: 1, status: 'complete' } };
    const api = { endOffRecord: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })), send: vi.fn().mockResolvedValue(response) };
    const client = { timeline: api } as unknown as NeoClient;
    useSession.setState({ wsStatus: 'open' });
    const ending = endTimelineOffRecord(client);
    const sending = sendMessage(client, { text: 'Normal', offRecord: false }, t);
    expect(api.send).not.toHaveBeenCalled();
    finish();
    await Promise.all([ending, sending]);
    expect(api.send).toHaveBeenCalledExactlyOnceWith({ text: 'Normal' });
  });

  it('can cancel a send while an off-record deletion is pending', async () => {
    let finish!: () => void;
    const api = { endOffRecord: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })), send: vi.fn(), cancel: vi.fn().mockResolvedValue({ cancelled: false }) };
    const client = { timeline: api } as unknown as NeoClient;
    useSession.setState({ wsStatus: 'open' });
    const ending = endTimelineOffRecord(client);
    const sending = sendMessage(client, { text: 'Normal' }, t);
    const rejected = expect(sending).rejects.toMatchObject({ code: 'cancelled' });
    await cancelTurn(client, t);
    finish();
    await Promise.all([ending, rejected]);
    expect(api.send).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts).toEqual([]);
  });
});

function timelineMessage(id: string, episodeId = 'ep'): Message {
  return { id, episodeId, conversationId: episodeId, role: 'user', parts: [{ type: 'text', text: id }], createdAt: 1, status: 'complete' };
}

function deletionClient(derivedMemories = 0) {
  const result = { deleted: 1, messageIds: ['delete_me'], derivedMemories };
  const deleteOne = vi.fn().mockResolvedValue(result);
  const deleteRangeApi = vi.fn().mockResolvedValue(result);
  const forget = vi.fn().mockResolvedValue({ deleted: derivedMemories });
  return { client: { timeline: { deleteMessage: deleteOne, deleteRange: deleteRangeApi }, memory: { forgetBySource: forget } } as unknown as NeoClient,
    deleteOne, deleteRangeApi, forget };
}

describe('message and range deletion', () => {
  it('requires confirmation before deleting a message', async () => {
    const { client, deleteOne } = deletionClient();
    const confirm = vi.fn().mockResolvedValue(false);
    expect(await deleteMessage(client, 'delete_me', t, confirm)).toBe(false);
    expect(deleteOne).not.toHaveBeenCalled();
  });

  it('removes the message first and separately offers to forget its derived memories', async () => {
    const { client, deleteOne, forget } = deletionClient(3);
    useTimeline.setState({ messages: [timelineMessage('keep_me'), timelineMessage('delete_me')] });
    const confirm = vi.fn().mockResolvedValue(true);
    expect(await deleteMessage(client, 'delete_me', t, confirm)).toBe(true);
    expect(deleteOne).toHaveBeenCalledWith('delete_me');
    expect(useTimeline.getState().messages.map((message) => message.id)).toEqual(['keep_me']);
    expect(confirm.mock.calls[1]![0]).toMatchObject({ confirmLabel: t('timeline.forget_memories', { n: 3 }), danger: true });
    expect(forget).toHaveBeenCalledWith(['delete_me']);
    applyTimelineEvent({ type: 'message.completed', episodeId: 'ep', conversationId: 'ep', turnId: 'turn', message: timelineMessage('delete_me') });
    expect(useTimeline.getState().messages.map((message) => message.id)).toEqual(['keep_me']);
  });

  it('can retain the memories while deleting their source message', async () => {
    const { client, forget } = deletionClient(2);
    const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await deleteMessage(client, 'delete_me', t, confirm)).toBe(true);
    expect(forget).not.toHaveBeenCalled();
  });

  it('confirms the actual range and uses the same separate forget option', async () => {
    const { client, deleteRangeApi, forget } = deletionClient(2);
    useSession.setState({ settings: DEFAULT_SETTINGS });
    const range = { from: '2026-10-12T00:00:00Z', to: '2026-10-12T01:00:00Z' };
    const confirm = vi.fn().mockResolvedValue(true);
    expect(await deleteRange(client, range, t, confirm)).toBe(true);
    expect(confirm.mock.calls[0]![0]).toMatchObject({ detail: expect.stringContaining('2026'), danger: true });
    expect(deleteRangeApi).toHaveBeenCalledWith(range);
    expect(forget).toHaveBeenCalledWith(['delete_me']);
  });

  it('a late deletion cannot remove a newer session’s messages or offer forgetting', async () => {
    const { client, deleteOne, forget } = deletionClient(3);
    let finish!: (value: unknown) => void;
    deleteOne.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const confirm = vi.fn().mockResolvedValue(true);
    const deleting = deleteMessage(client, 'delete_me', t, confirm);
    await vi.waitFor(() => expect(deleteOne).toHaveBeenCalledOnce());
    startSession({ serverUrl: 'https://new.example', token: 'token' }, 'manual');
    useTimeline.setState({ messages: [timelineMessage('delete_me')] });
    finish({ deleted: 1, messageIds: ['delete_me'], derivedMemories: 3 });
    expect(await deleting).toBe(false);
    expect(useTimeline.getState().messages).toHaveLength(1);
    expect(confirm).toHaveBeenCalledOnce();
    expect(forget).not.toHaveBeenCalled();
  });
});

describe('off-record preference and cleanup', () => {
  it('persists private mode and episode ids until successful end, preserving legacy private history', async () => {
    resetTimeline('https://fixture.example');
    const endOffRecord = vi.fn().mockResolvedValue({ deleted: 1 });
    const client = { timeline: { startOffRecord: vi.fn().mockResolvedValue({ active: true, episodeId: null, startedAt: 1 }), endOffRecord } } as unknown as NeoClient;
    await setOffRecord(client, true, t);
    applyTimelineEvent({ type: 'episode.started', episodeId: 'private', episode: { id: 'private', kind: 'episode', offRecord: true, ephemeral: true, startedAt: 1, closedAt: null, lastMessageAt: 1 } });
    useTimeline.setState({ messages: [timelineMessage('normal'), timelineMessage('secret', 'private'), timelineMessage('legacy', 'legacy')],
      episodes: { ...useTimeline.getState().episodes, legacy: { episodeId: 'legacy', startedAt: 0, offRecord: true, ephemeral: false } } });
    resetTimeline('https://fixture.example');
    expect(useTimeline.getState()).toMatchObject({ offRecord: true, episodes: { private: { ephemeral: true } } });
    useTimeline.setState({ messages: [timelineMessage('normal'), timelineMessage('secret', 'private'), timelineMessage('legacy', 'legacy')],
      episodes: { ...useTimeline.getState().episodes, legacy: { episodeId: 'legacy', startedAt: 0, offRecord: true, ephemeral: false } } });
    await setOffRecord(client, false, t);
    expect(endOffRecord).toHaveBeenCalledOnce();
    expect(useTimeline.getState().offRecord).toBe(false);
    expect(useTimeline.getState().messages.map((message) => message.id)).toEqual(['normal', 'legacy']);
    resetTimeline('https://fixture.example');
    expect(useTimeline.getState().offRecord).toBe(false);
  });

  it('private mode never carries over to a different server', async () => {
    resetTimeline('https://a.example');
    await setOffRecord({ timeline: { startOffRecord: vi.fn().mockResolvedValue({ active: true, episodeId: null, startedAt: 1 }) } } as unknown as NeoClient, true, t);
    resetTimeline('https://b.example');
    expect(useTimeline.getState().offRecord).toBe(false);
    resetTimeline('https://a.example');
    expect(useTimeline.getState().offRecord).toBe(true);
  });

  it('a failed end leaves the mode on and messages visible for retry', async () => {
    const client = { timeline: { endOffRecord: vi.fn().mockRejectedValue(new Error('Offline')) } } as unknown as NeoClient;
    useTimeline.setState({ offRecord: true, messages: [timelineMessage('secret')] });
    await expect(setOffRecord(client, false, t)).rejects.toThrow('Offline');
    expect(useTimeline.getState()).toMatchObject({ offRecord: true, endingOffRecord: false });
    expect(useTimeline.getState().messages).toHaveLength(1);
  });

  it('waits for an in-flight private acceptance before ending it, preventing late resurrection', async () => {
    let accept!: (response: unknown) => void;
    const api = { send: vi.fn().mockReturnValue(new Promise((resolve) => { accept = resolve; })), cancel: vi.fn().mockResolvedValue({ cancelled: true }), endOffRecord: vi.fn().mockResolvedValue({ deleted: 1 }) };
    const client = { timeline: api } as unknown as NeoClient;
    useSession.setState({ wsStatus: 'open' });
    useTimeline.setState({ offRecord: true, episodes: { private: { episodeId: 'private', startedAt: 1, offRecord: true, ephemeral: true } } });
    const sending = sendMessage(client, { text: 'Secret' }, t);
    const ending = setOffRecord(client, false, t);
    expect(useTimeline.getState().endingOffRecord).toBe(true);
    expect(api.endOffRecord).not.toHaveBeenCalled();
    accept({ episodeId: 'private', turnId: 'turn_private', userMessage: timelineMessage('secret', 'private'), assistantMessageId: 'assistant_private' });
    await Promise.all([sending, ending]);
    expect(api.send).toHaveBeenCalledWith({ text: 'Secret' });
    expect(api.endOffRecord).toHaveBeenCalledOnce();
    expect(useTimeline.getState()).toMatchObject({ offRecord: false, messages: [], turn: null });
    applyTurnResponse({ turnId: 'turn_private', userMessage: timelineMessage('secret', 'private'), assistantMessageId: 'assistant_private' });
    expect(useTimeline.getState().messages).toEqual([]);
  });
});

it('refetches after ending privacy to remove unknown private episodes while retaining legacy private messages', async () => {
  const legacy = timelineMessage('legacy_private', 'legacy');
  const privateMessage = timelineMessage('unknown_private', 'unknown');
  const list = vi.fn().mockResolvedValue({ items: [legacy], episodes: [{ episodeId: 'legacy', startedAt: 1, offRecord: true }], nextCursor: null });
  const client = { timeline: { endOffRecord: vi.fn().mockResolvedValue({ deleted: 1 }), list } } as unknown as NeoClient;
  useSession.setState({ client, wsStatus: 'idle' });
  useTimeline.setState({ offRecord: true, loaded: true, messages: [legacy, privateMessage],
    episodes: { legacy: { episodeId: 'legacy', startedAt: 1, offRecord: true }, unknown: { episodeId: 'unknown', startedAt: 1, offRecord: true } } });
  await setOffRecord(client, false, t);
  expect(list).toHaveBeenCalledExactlyOnceWith({ limit: 100 });
  expect(useTimeline.getState()).toMatchObject({ offRecord: false, endingOffRecord: false, messages: [legacy] });
});

it('keeps privacy ended after a refresh failure and offers a guarded refresh retry', async () => {
  const normal = timelineMessage('normal');
  const list = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ items: [normal], episodes: [], nextCursor: null });
  const endOffRecord = vi.fn().mockResolvedValue({ deleted: 1 });
  const client = { timeline: { endOffRecord, list } } as unknown as NeoClient;
  useSession.setState({ client, wsStatus: 'idle' });
  useTimeline.setState({ offRecord: true, messages: [normal, timelineMessage('secret', 'private')],
    episodes: { private: { episodeId: 'private', startedAt: 1, offRecord: true, ephemeral: true } } });
  await expect(setOffRecord(client, false, t)).resolves.toBeUndefined();
  expect(useTimeline.getState()).toMatchObject({ offRecord: false, endingOffRecord: false, messages: [normal] });
  const toast = useToasts.getState().toasts.at(-1)!;
  expect(toast.title).toBe(t('timeline.load_error'));
  expect(toast.actions![0]!.label).toBe(t('common.retry'));
  toast.actions![0]!.onClick();
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(endOffRecord).toHaveBeenCalledOnce();
  startSession({ serverUrl: 'https://new.example', token: 'token' }, 'manual');
  toast.actions![0]!.onClick();
  expect(list).toHaveBeenCalledTimes(2);
});

it('a delayed privacy refresh cannot overwrite a newer session', async () => {
  let complete!: (value: unknown) => void;
  const list = vi.fn().mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  const client = { timeline: { endOffRecord: vi.fn().mockResolvedValue({ deleted: 1 }), list } } as unknown as NeoClient;
  useSession.setState({ client, wsStatus: 'idle' });
  useTimeline.setState({ offRecord: true });
  const ending = setOffRecord(client, false, t);
  await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
  startSession({ serverUrl: 'https://new.example', token: 'token' }, 'manual');
  const current = timelineMessage('current');
  useTimeline.setState({ messages: [current] });
  complete({ items: [], episodes: [], nextCursor: null });
  await ending;
  expect(useTimeline.getState().messages).toEqual([current]);
});


describe('authoritative off-record start', () => {
  it('waits for server entry before an older generated action or confirmation runs', async () => {
    let entered!: (state: { active: boolean; episodeId: string; startedAt: number }) => void;
    const api = { startOffRecord: vi.fn().mockReturnValue(new Promise((resolve) => { entered = resolve; })), uiAction: vi.fn().mockResolvedValue({ kind: 'noop' }) };
    const respond = vi.fn().mockResolvedValue({ ok: true });
    const client = { timeline: api, confirmations: { respond } } as unknown as NeoClient;
    const starting = setOffRecord(client, true, t);
    const actionRunning = runUiAction(client, input, t);
    const approving = respondToConfirmation(client, 'normal-confirmation', { approve: true }, t);
    expect(useTimeline.getState()).toMatchObject({ offRecord: false, startingOffRecord: true });
    expect(api.uiAction).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    entered({ active: true, episodeId: 'private', startedAt: 10 });
    await Promise.all([starting, actionRunning, approving]);
    expect(useTimeline.getState()).toMatchObject({ offRecord: true, offRecordLoaded: true, startingOffRecord: false, episodes: { private: { offRecord: true, ephemeral: true } } });
    expect(api.uiAction).toHaveBeenCalledExactlyOnceWith({ messageId: 'msg_1', uiId: 'ui_1', actionId: 'del' });
    expect(respond).toHaveBeenCalledExactlyOnceWith('normal-confirmation', { approve: true });
  });

  it('leaves the toggle off and reports a failed start', async () => {
    const client = { timeline: { startOffRecord: vi.fn().mockRejectedValue(new Error('Offline')) } } as unknown as NeoClient;
    await expect(setOffRecord(client, true, t)).rejects.toThrow('Offline');
    expect(useTimeline.getState()).toMatchObject({ offRecord: false, startingOffRecord: false });
    expect(useToasts.getState().toasts.at(-1)!.title).toBe(t('timeline.off_record_start_error'));
  });

  it('ignores a delayed start result after changing servers', async () => {
    let entered!: (state: { active: boolean; episodeId: string; startedAt: number }) => void;
    const client = { timeline: { startOffRecord: vi.fn().mockReturnValue(new Promise((resolve) => { entered = resolve; })) } } as unknown as NeoClient;
    const starting = setOffRecord(client, true, t);
    startSession({ serverUrl: 'https://new.example', token: 'token' }, 'manual');
    entered({ active: true, episodeId: 'old-private', startedAt: 10 });
    await starting;
    expect(useTimeline.getState()).toMatchObject({ offRecord: false, startingOffRecord: false, episodes: {} });
  });

  it('keeps a newer device start authoritative when an end response arrives late', async () => {
    let ended!: (state: { deleted: number }) => void;
    const client = { timeline: { endOffRecord: vi.fn().mockReturnValue(new Promise((resolve) => { ended = resolve; })) } } as unknown as NeoClient;
    useTimeline.setState({ offRecord: true });
    const ending = setOffRecord(client, false, t);
    applyTimelineEvent({ type: 'timeline.off_record', active: false });
    applyTimelineEvent({ type: 'timeline.off_record', active: true });
    applyTimelineEvent({ type: 'episode.started', episodeId: 'new-private', episode: { id: 'new-private', kind: 'episode', offRecord: true, ephemeral: true, startedAt: 10, closedAt: null, lastMessageAt: null } });
    ended({ deleted: 1 });
    await ending;
    expect(useTimeline.getState()).toMatchObject({ offRecord: true, endingOffRecord: false, episodes: { 'new-private': { ephemeral: true } } });
  });
});


it.each(['open', 'idle'] as const)('does not restart server privacy from a stale web toggle over %s transport', async (wsStatus) => {
  const response = { episodeId: 'normal', turnId: 'turn_normal', userMessage: timelineMessage('normal-user', 'normal'), assistantMessageId: 'normal-assistant' };
  const send = vi.fn().mockResolvedValue(response);
  const stream = vi.fn(async function* () { yield { ...response, type: 'turn.started' as const, conversationId: 'normal', model: { provider: 'local', model: 'model' } }; });
  const client = { timeline: { send, stream } } as unknown as NeoClient;
  useSession.setState({ wsStatus });
  useTimeline.setState({ offRecord: true });
  await sendMessage(client, { text: 'After another device ended privacy', offRecord: true }, t);
  if (wsStatus === 'open') expect(send).toHaveBeenCalledExactlyOnceWith({ text: 'After another device ended privacy' });
  else expect(stream).toHaveBeenCalledExactlyOnceWith({ text: 'After another device ended privacy' }, expect.any(AbortSignal));
  applyTimelineEvent({ type: 'timeline.off_record', active: false });
  expect(useTimeline.getState().messages.some((message) => message.id === 'normal-user')).toBe(true);
  expect(useTimeline.getState().deletedEpisodes.normal).toBeUndefined();
});
