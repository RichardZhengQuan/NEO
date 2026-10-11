/**
 * UI actions that need approval (security audit NEO-16) and tool confirmations
 * answered by their server nonce (NEO-04).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoClient } from '@neo/client';
import type { ToolConfirmation, UIAction, UiActionConfirmation, UiActionRequest, UiActionResponse } from '@neo/protocol';
import { buildMessages, createTranslator } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { useConversations } from '../state/conversations.js';
import { useToasts } from '../state/notifications.js';
import { respondToConfirmation, runUiAction, UiActionCancelled } from './chat.js';

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
