/**
 * Chat actions: start conversations, send, stop, retry, UI actions, tool
 * confirmations and memory approvals. Errors surface as toasts; functions that
 * the UI awaits for spinners rethrow.
 */
import type { NeoClient } from '@neo/client';
import type {
  ConfirmationDecision,
  Conversation,
  ImagePart,
  Message,
  ModelRef,
  SendMessageRequest,
  SendMessageResponse,
  UIAction,
  UiActionConfirmation,
  UiActionRequest,
  UiActionResponse,
  UserInputPart,
} from '@neo/protocol';
import { textOf } from '@neo/protocol';
import { copyText, type TranslateFn } from '@neo/ui';
import { errorCode, errorMessage, httpStatus } from '../lib/errors.js';
import { navigate } from '../router.js';
import { applyConversationEvent, removeConversation, resolveNoticeItem, upsertConversation, useConversations } from '../state/conversations.js';
import { bumpMemoryVersion, refreshPendingMemories } from '../state/data.js';
import { dismissToastKey, pushToast } from '../state/notifications.js';
import { useSession } from '../state/session.js';
import { openLink } from './links.js';

function reportError(err: unknown, t: TranslateFn, title?: string): void {
  const code = errorCode(err);
  pushToast({
    tone: 'error',
    title: title ?? errorMessage(err, t),
    body: title ? errorMessage(err, t) : undefined,
    actions: code === 'config_error' || code === 'provider_auth' ? [{ label: t('chat.open_ai_settings'), onClick: () => navigate({ name: 'settings', section: 'ai' }) }] : undefined,
  });
}

/** Record the start of a turn from an HTTP response (the WebSocket event may come first or later). */
export function applyTurnResponse(conversationId: string, res: Pick<SendMessageResponse, 'turnId' | 'userMessage' | 'assistantMessageId'>): void {
  const { conversations, entries } = useConversations.getState();
  const existing = entries[conversationId]?.messages.find((m) => m.id === res.assistantMessageId);
  if (existing && existing.status !== 'streaming') {
    // The turn already finished over the WebSocket; only make sure the user message is there.
    if (!entries[conversationId]?.messages.some((m) => m.id === res.userMessage.id)) {
      useConversations.setState((s) => {
        const entry = s.entries[conversationId]!;
        return { entries: { ...s.entries, [conversationId]: { ...entry, messages: [...entry.messages, res.userMessage].sort((a, b) => a.createdAt - b.createdAt) } } };
      });
    }
    return;
  }
  const settings = useSession.getState().settings;
  const model: ModelRef = conversations[conversationId]?.model ?? settings?.defaultModel ?? { provider: '', model: '' };
  applyConversationEvent({ type: 'turn.started', conversationId, turnId: res.turnId, userMessage: res.userMessage, assistantMessageId: res.assistantMessageId, model });
}

export async function createConversation(client: NeoClient, options: { incognito?: boolean; model?: ModelRef | null } = {}): Promise<Conversation> {
  const conv = await client.conversations.create({ incognito: options.incognito ?? false, model: options.model ?? null });
  upsertConversation(conv);
  return conv;
}

/**
 * Send a message. Uses the WebSocket for streaming when it is open; otherwise
 * streams this turn over SSE so the reply still appears live.
 */
export async function sendMessage(client: NeoClient, conversationId: string, body: SendMessageRequest, t: TranslateFn): Promise<void> {
  if (useSession.getState().wsStatus === 'open') {
    try {
      const res = await client.conversations.send(conversationId, body);
      applyTurnResponse(conversationId, res);
    } catch (err) {
      reportError(err, t, httpStatus(err) === 409 ? t('chat.busy') : undefined);
      throw err;
    }
    return;
  }
  const stream = client.conversations.stream(conversationId, body);
  void (async () => {
    try {
      for await (const event of stream) applyConversationEvent(event);
    } catch (err) {
      reportError(err, t);
    }
  })();
}

export function composeBody(text: string, images: ImagePart[]): SendMessageRequest {
  const body: SendMessageRequest = {};
  if (text.trim()) body.text = text.trim();
  if (images.length) body.parts = images;
  return body;
}

export async function cancelTurn(client: NeoClient, conversationId: string, t: TranslateFn): Promise<void> {
  const turn = useConversations.getState().entries[conversationId]?.turn;
  try {
    await client.conversations.cancel(conversationId, turn?.turnId);
  } catch (err) {
    reportError(err, t);
  }
}

/** Resend the user message that led to `assistant` (after an error or a stop). */
export async function retryTurn(client: NeoClient, conversationId: string, assistant: Message, t: TranslateFn): Promise<void> {
  const messages = useConversations.getState().entries[conversationId]?.messages ?? [];
  const idx = messages.findIndex((m) => m.id === assistant.id);
  const user = [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
  if (!user) return;
  const text = textOf(user.parts);
  const images = user.parts.filter((p): p is Extract<UserInputPart, { type: 'image' }> => p.type === 'image');
  if (!text.trim() && !images.length) {
    pushToast({ tone: 'warning', title: t('chat.retry_unavailable') });
    return;
  }
  await sendMessage(client, conversationId, composeBody(text, images), t).catch(() => undefined);
}

/** The user declined the server's confirmation for a UI action (nothing was run). */
export class UiActionCancelled extends Error {
  constructor() {
    super('ui action cancelled');
    this.name = 'UiActionCancelled';
  }
}

/** Shows the server's confirmation for a UI action; resolves true when approved. */
export type AskUiActionConfirm = (confirmation: UiActionConfirmation) => Promise<boolean>;

/**
 * A generative-UI interaction. The server resolves the action from the stored
 * message and tells us what to do: start a turn, show a tool's result, perform
 * a client action (open a link, copy text), or ask first.
 *
 * "Ask first" (`kind: 'confirm'`) comes from the server when the action runs a
 * tool that needs approval. Its title/description/risk are generated by the
 * server from the real tool call, so that is all the dialog shows. Approving
 * resends the exact same request with the one-time `confirmationToken`; a
 * stale or rejected token (400/409) gets a toast and one fresh attempt.
 *
 * Throws when the action failed or was declined, so widgets can revert
 * optimistic state (a decline is a `UiActionCancelled`, with no toast).
 */
export async function runUiAction(
  client: NeoClient,
  conversationId: string,
  input: { messageId: string; uiId: string; action: UIAction; values?: Record<string, unknown> },
  t: TranslateFn,
  askConfirm?: AskUiActionConfirm,
): Promise<void> {
  const request: UiActionRequest = { messageId: input.messageId, uiId: input.uiId, actionId: input.action.id };
  if (input.values) request.values = input.values;
  const send = async (body: UiActionRequest): Promise<UiActionResponse> => {
    try {
      return await client.conversations.uiAction(conversationId, body);
    } catch (err) {
      reportError(err, t);
      throw err;
    }
  };

  let res = await send(request);
  let freshAttempts = 0;
  while (res.kind === 'confirm') {
    const approved = askConfirm ? await askConfirm(res.confirmation) : false;
    if (!approved) throw new UiActionCancelled();
    try {
      res = await client.conversations.uiAction(conversationId, { ...request, confirmationToken: res.confirmation.token });
    } catch (err) {
      const status = httpStatus(err);
      if ((status === 400 || status === 409) && freshAttempts < 1) {
        freshAttempts++;
        pushToast({ tone: 'warning', title: t('chat.action_confirm_expired') });
        res = await send(request);
        continue;
      }
      reportError(err, t);
      throw err;
    }
  }

  switch (res.kind) {
    case 'turn':
      applyTurnResponse(conversationId, res);
      return;
    case 'tool':
      if (res.isError) {
        pushToast({ tone: 'error', title: res.summary ?? t('chat.action_failed') });
        throw new Error(res.summary ?? 'tool failed');
      }
      // Quiet success for live widgets (the widget itself updates); others get a confirmation.
      if (!/^(task\.toggle|reminder\.|memory\.)/.test(input.action.id) || res.summary) {
        pushToast({ tone: 'success', title: res.summary ?? t('chat.action_done'), icon: 'check-circle' });
      }
      if (input.action.id.startsWith('memory.') || (input.action.kind === 'tool' && /memory|forget|remember/.test(input.action.tool))) {
        bumpMemoryVersion();
        void refreshPendingMemories(client);
      }
      return;
    case 'client':
      await performClientAction(res.action, t);
      return;
    case 'noop':
      return;
  }
}

export async function performClientAction(action: UIAction, t: TranslateFn): Promise<void> {
  if (action.kind === 'link') {
    openLink(action.url);
  } else if (action.kind === 'copy') {
    const ok = await copyText(action.text);
    pushToast({ tone: ok ? 'success' : 'error', title: ok ? t('common.copied') : t('chat.copy_failed') });
  }
}

/** Answer a tool confirmation by its server nonce (`ToolConfirmation.id`), never by tool call id. */
export async function respondToConfirmation(client: NeoClient, conversationId: string, confirmationId: string, decision: ConfirmationDecision, t: TranslateFn): Promise<void> {
  const confirmation = useConversations.getState().entries[conversationId]?.confirmations.find((c) => c.id === confirmationId);
  try {
    await client.confirmations.respond(confirmationId, decision);
  } catch (err) {
    if (httpStatus(err) === 404) pushToast({ tone: 'warning', title: t('chat.confirmation_expired') });
    else {
      reportError(err, t);
      throw err;
    }
  }
  dismissToastKey(`confirm:${confirmationId}`);
  if (confirmation) {
    applyConversationEvent({ type: 'tool.confirmation_resolved', conversationId, turnId: confirmation.turnId, confirmationId: confirmation.id, toolCallId: confirmation.toolCallId, approved: decision.approve, reason: 'user' });
  }
}

export async function decidePendingMemories(client: NeoClient, conversationId: string, turnId: string, ids: string[], decision: 'approved' | 'rejected', t: TranslateFn): Promise<void> {
  if (!ids.length) return;
  try {
    if (decision === 'approved') await client.memory.approve(ids);
    else await client.memory.reject(ids);
    for (const id of ids) resolveNoticeItem(conversationId, turnId, id, decision);
    bumpMemoryVersion();
    void refreshPendingMemories(client);
  } catch (err) {
    reportError(err, t);
  }
}

export async function renameConversation(client: NeoClient, id: string, title: string, t: TranslateFn): Promise<void> {
  try {
    upsertConversation(await client.conversations.update(id, { title }));
  } catch (err) {
    reportError(err, t);
  }
}

export async function setConversationModel(client: NeoClient, id: string, model: ModelRef | null, t: TranslateFn): Promise<void> {
  try {
    upsertConversation(await client.conversations.update(id, { model }));
  } catch (err) {
    reportError(err, t);
  }
}

export async function setConversationFlags(client: NeoClient, id: string, flags: { pinned?: boolean; archived?: boolean }, t: TranslateFn): Promise<void> {
  try {
    upsertConversation(await client.conversations.update(id, flags));
  } catch (err) {
    reportError(err, t);
  }
}

export async function deleteConversation(client: NeoClient, id: string, t: TranslateFn): Promise<boolean> {
  try {
    await client.conversations.delete(id);
    removeConversation(id);
    return true;
  } catch (err) {
    reportError(err, t);
    return false;
  }
}
