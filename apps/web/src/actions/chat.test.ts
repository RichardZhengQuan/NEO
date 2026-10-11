/**
 * UI actions that need approval (security audit NEO-16) and tool confirmations
 * answered by their server nonce (NEO-04).
 *
 * Also includes F09 composeBody tests: text+image submissions must include
 * both the text and the image in the parts array sent to the server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoClient } from '@neo/client';
import type { ImagePart, Message, SendMessageRequest, ToolConfirmation, UIAction, UiActionConfirmation, UiActionRequest, UiActionResponse } from '@neo/protocol';
import { buildMessages, createTranslator } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { useConversations } from '../state/conversations.js';
import { startSession, useSession } from '../state/session.js';
import { useToasts } from '../state/notifications.js';
import { composeBody, retryTurn, sendMessage, renameConversation, respondToConfirmation, runUiAction, UiActionCancelled } from './chat.js';

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
  const uiAction = vi.fn(async (_id: string, _body: UiActionRequest): Promise<UiActionResponse> => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
  const respond = vi.fn(async () => ({ ok: true }));
  return { client: { conversations: { uiAction }, confirmations: { respond } } as unknown as NeoClient, uiAction, respond };
}

beforeEach(() => {
  useConversations.setState({ conversations: {}, entries: {}, listLoaded: false, archivedLoaded: false });
  useToasts.setState({ toasts: [] });
});

describe('runUiAction with server confirmation', () => {
  it('shows only the server confirmation, then resends the same request with the token', async () => {
    const { client, uiAction } = fakeClient([{ kind: 'confirm', confirmation: confirmation('tok_1') }, done]);
    const ask = vi.fn(async () => true);
    await runUiAction(client, 'conv_1', input, t, ask);
    expect(ask).toHaveBeenCalledWith(confirmation('tok_1'));
    expect(uiAction).toHaveBeenCalledTimes(2);
    expect(uiAction.mock.calls[0]![1]).toEqual({ messageId: 'msg_1', uiId: 'ui_1', actionId: 'del' });
    expect(uiAction.mock.calls[1]![1]).toEqual({ messageId: 'msg_1', uiId: 'ui_1', actionId: 'del', confirmationToken: 'tok_1' });
    expect(useToasts.getState().toasts[0]!.title).toBe('Deleted');
  });

  it('cancel sends nothing more and rejects quietly', async () => {
    const { client, uiAction } = fakeClient([{ kind: 'confirm', confirmation: confirmation('tok_1') }]);
    await expect(runUiAction(client, 'conv_1', input, t, async () => false)).rejects.toBeInstanceOf(UiActionCancelled);
    expect(uiAction).toHaveBeenCalledTimes(1);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('without a way to ask, a confirm response is treated as declined', async () => {
    const { client, uiAction } = fakeClient([{ kind: 'confirm', confirmation: confirmation('tok_1') }]);
    await expect(runUiAction(client, 'conv_1', input, t)).rejects.toBeInstanceOf(UiActionCancelled);
    expect(uiAction).toHaveBeenCalledTimes(1);
  });

  it.each([400, 409])('an expired or invalid token (%i) gets a toast and one fresh attempt', async (status) => {
    const { client, uiAction } = fakeClient([{ kind: 'confirm', confirmation: confirmation('tok_1') }, httpError(status), { kind: 'confirm', confirmation: confirmation('tok_2') }, done]);
    const ask = vi.fn(async () => true);
    await runUiAction(client, 'conv_1', input, t, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(uiAction.mock.calls.map((c) => c[1].confirmationToken)).toEqual([undefined, 'tok_1', undefined, 'tok_2']);
    expect(useToasts.getState().toasts.map((x) => x.title)).toContain('That approval expired. Please check it again.');
  });

  it('gives up after the fresh attempt also fails', async () => {
    const { client, uiAction } = fakeClient([
      { kind: 'confirm', confirmation: confirmation('tok_1') },
      httpError(409),
      { kind: 'confirm', confirmation: confirmation('tok_2') },
      httpError(409),
    ]);
    await expect(runUiAction(client, 'conv_1', input, t, async () => true)).rejects.toThrow('HTTP 409');
    expect(uiAction).toHaveBeenCalledTimes(4);
  });

  it('actions that need no approval run in one request', async () => {
    const { client, uiAction } = fakeClient([done]);
    const ask = vi.fn(async () => true);
    await runUiAction(client, 'conv_1', input, t, ask);
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
      conversationId: 'conv_1',
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
    useConversations.setState({
      entries: { conv_1: { messages: [], hasMore: false, loaded: true, turn: null, confirmations: [pending], recalled: {}, notices: {}, lastError: null } },
    });
    const { client, respond } = fakeClient([]);
    await respondToConfirmation(client, 'conv_1', 'cnf_abc', { approve: true }, t);
    expect(respond).toHaveBeenCalledWith('cnf_abc', { approve: true });
    expect(useConversations.getState().entries.conv_1!.confirmations).toHaveLength(0);
  });
});



function retryMessages(parts: Message['parts']): Message {
  const user: Message = { id: 'user_1', conversationId: 'conv_1', role: 'user', parts, createdAt: 1, status: 'complete' };
  const assistant: Message = { id: 'assistant_1', conversationId: 'conv_1', role: 'assistant', parts: [], createdAt: 2, status: 'error' };
  useConversations.setState({ entries: { conv_1: { messages: [user, assistant], hasMore: false, loaded: true, turn: null, confirmations: [], recalled: {}, notices: {}, lastError: null } } });
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
    const client = { conversations: { stream } } as unknown as NeoClient;
    useSession.setState({ wsStatus: 'idle' });
    await retryTurn(client, 'conv_1', assistant, t);
    expect(stream).toHaveBeenCalledWith('conv_1', expected, expect.any(AbortSignal));
  });
});

describe('chat responses are scoped to their session', () => {
  it('ignores late HTTP turn and conversation-update responses after switching', async () => {
    let resolveSend!: (value: unknown) => void;
    let resolveUpdate!: (value: unknown) => void;
    const client = { conversations: {
      send: vi.fn(() => new Promise((resolve) => { resolveSend = resolve; })),
      update: vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; })),
    } } as unknown as NeoClient;
    useSession.setState({ wsStatus: 'open' });
    const send = sendMessage(client, 'conv_old', { text: 'Hello' }, t);
    const update = renameConversation(client, 'conv_old', 'Old server title', t);
    useSession.setState((s) => ({ sessionEpoch: s.sessionEpoch + 1 }));
    resolveSend({ turnId: 'old_turn', assistantMessageId: 'old_assistant', userMessage: { id: 'old_user', role: 'user', parts: [{ type: 'text', text: 'Hello' }], conversationId: 'conv_old', createdAt: 1, status: 'complete' } });
    resolveUpdate({ id: 'conv_old', title: 'Old server title' });
    await Promise.all([send, update]);
    expect(useConversations.getState().entries).toEqual({});
    expect(useConversations.getState().conversations).toEqual({});
  });

  it('ignores a late SSE event after switching servers', async () => {
    let resolveEvent!: () => void;
    const waiting = new Promise<void>((resolve) => { resolveEvent = resolve; });
    let done!: () => void;
    const finished = new Promise<void>((resolve) => { done = resolve; });
    let signal: AbortSignal | undefined;
    const client = { conversations: { stream: async function* (_id: string, _body: SendMessageRequest, abortSignal?: AbortSignal) {
      signal = abortSignal;
      try {
        await waiting;
        yield { type: 'text.delta' as const, conversationId: 'conv_old', turnId: 'old_turn', messageId: 'old_message', text: 'Old server text' };
      } finally { done(); }
    } } } as unknown as NeoClient;
    useSession.setState({ wsStatus: 'idle' });
    await sendMessage(client, 'conv_old', { text: 'Hello' }, t);
    startSession('https://new.example', 'token', 'manual');
    expect(signal?.aborted).toBe(true);
    resolveEvent();
    await finished;
    expect(useConversations.getState().entries).toEqual({});
  });
});
