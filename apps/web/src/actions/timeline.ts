/**
 * Timeline actions: send, stop, retry, privacy, deletion, UI actions and tool
 * confirmations. Errors surface as toasts; functions that
 * the UI awaits for spinners rethrow.
 */
import type { NeoClient } from '@neo/client';
import type {
  ConfirmationDecision,
  ImagePart,
  Message,
  ModelRef,
  SendMessageRequest,
  SendMessageResponse,
  TimelineDeleteResult,
  UIAction,
  UiActionConfirmation,
  UiActionRequest,
  UiActionResponse,
  UserInputPart,
} from '@neo/protocol';
import { NeoError, UI_ACTION_ID_PREFIX, textOf } from '@neo/protocol';
import { copyText, type ConfirmFn, type TranslateFn } from '@neo/ui';
import { errorCode, errorMessage, httpStatus } from '../lib/errors.js';
import { navigate } from '../router.js';
import { applyOffRecordState, applyTimelineEvent, beginTimelineStream, setTimeline, useTimeline, withoutMessages, withoutPrivateEpisodes } from '../state/timeline.js';
import { loadTimeline } from '../state/connection.js';
import { bumpMemoryVersion } from '../state/data.js';
import { dismissToastKey, pushToast } from '../state/notifications.js';
import { currentSessionEpoch, isCurrentSession, onSessionEnd, useSession } from '../state/session.js';
import { openLink } from './links.js';

function reportError(err: unknown, t: TranslateFn, title?: string): void {
  const code = errorCode(err);
  pushToast({
    tone: 'error',
    title: title ?? errorMessage(err, t),
    body: title ? errorMessage(err, t) : undefined,
    actions: code === 'no_provider' || code === 'config_error' || code === 'provider_auth' ? [{ label: t('chat.open_ai_settings'), onClick: () => navigate({ name: 'settings', section: 'ai' }) }] : undefined,
  });
}

/** Record the start of a turn from an HTTP response (the WebSocket event may come first or later). */
export function applyTurnResponse(res: Pick<SendMessageResponse, 'turnId' | 'userMessage' | 'assistantMessageId'>): void {
  const entry = useTimeline.getState();
  const episodeId = res.userMessage.episodeId ?? res.userMessage.conversationId;
  if (entry.deletedEpisodes[episodeId] || entry.deletedMessageIds[res.userMessage.id] || entry.deletedMessageIds[res.assistantMessageId]) return;
  const existing = entry.messages.find((message) => message.id === res.assistantMessageId);
  if (existing && existing.status !== 'streaming') {
    // A completed WebSocket turn can arrive before its HTTP acceptance.
    if (!entry.messages.some((message) => message.id === res.userMessage.id)) {
      setTimeline((current) => ({ ...current, messages: current.messages.flatMap((message) => message.id === res.assistantMessageId ? [res.userMessage, message] : [message]) }));
    }
    return;
  }
  const settings = useSession.getState().settings;
  const model: ModelRef = (entry.turn?.turnId === res.turnId ? entry.turn.model : null) ?? settings?.ai.capabilities.text ?? { provider: '', model: '' };
  setTimeline((current) => ({ ...current, episodes: { ...current.episodes,
    [episodeId]: current.episodes[episodeId] ?? { episodeId, startedAt: res.userMessage.createdAt, offRecord: false, ephemeral: false, firstMessageId: res.userMessage.id } } }));
  applyTimelineEvent({ type: 'turn.started', conversationId: episodeId, episodeId, turnId: res.turnId, userMessage: res.userMessage, assistantMessageId: res.assistantMessageId, model });
}

/**
 * Send a message. Uses the WebSocket for streaming when it is open; otherwise
 * streams this turn over SSE so the reply still appears live.
 */
const offRecordTransitions = new WeakMap<NeoClient, Promise<unknown>>();
const pendingSends = new WeakMap<NeoClient, { cancelled: boolean; offRecord: boolean; settled: Promise<void> }>();

export function endTimelineOffRecord(client: NeoClient): Promise<unknown> {
  const existing = offRecordTransitions.get(client);
  if (existing) return existing;
  const ending = client.timeline.endOffRecord().finally(() => {
    if (offRecordTransitions.get(client) === ending) offRecordTransitions.delete(client);
  });
  offRecordTransitions.set(client, ending);
  return ending;
}

function waitForPrivacy(client: NeoClient): Promise<unknown> | undefined {
  return offRecordTransitions.get(client);
}

export async function sendMessage(client: NeoClient, body: SendMessageRequest, t: TranslateFn): Promise<void> {
  const epoch = currentSessionEpoch();
  let settled!: () => void;
  const pending = { cancelled: false, offRecord: useTimeline.getState().offRecord, settled: new Promise<void>((resolve) => { settled = resolve; }) };
  pendingSends.set(client, pending);
  const clearPending = () => { if (pendingSends.get(client) === pending) pendingSends.delete(client); settled(); };
  let reportsError = true;
  try {
    const transition = waitForPrivacy(client);
    if (transition) await transition;
    if (!isCurrentSession(epoch) || pending.cancelled) throw new NeoError('cancelled', 'The turn was cancelled.');
    const request = { ...body };
    delete request.offRecord;
    pending.offRecord = useTimeline.getState().offRecord;
    if (useSession.getState().wsStatus === 'open') {
      const res = await client.timeline.send(request);
      if (pending.cancelled) await client.timeline.cancel(res.turnId);
      if (isCurrentSession(epoch)) applyTurnResponse(res);
      clearPending();
      return;
    }
    reportsError = false;
    const controller = new AbortController();
    const unregister = onSessionEnd(() => controller.abort());
    const endStream = beginTimelineStream(client);
    let accepted = false;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const started = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    void (async () => {
      try {
        for await (const event of client.timeline.stream(request, controller.signal)) {
          if (!isCurrentSession(epoch)) break;
          applyTimelineEvent(event);
          if (pending.cancelled && event.type === 'turn.started') await client.timeline.cancel(event.turnId);
          if ((event.type === 'turn.started' || event.type === 'turn.failed') && !accepted) {
            accepted = true;
            clearPending();
            resolve();
          }
        }
        if (!accepted) resolve();
      } catch (err) {
        if (isCurrentSession(epoch) && errorCode(err) !== 'cancelled' && !(err instanceof Error && err.name === 'AbortError')) reportError(err, t);
        if (!accepted) reject(err);
      } finally {
        clearPending();
        endStream();
        unregister();
      }
    })();
    await started;
  } catch (err) {
    clearPending();
    if (reportsError && isCurrentSession(epoch) && errorCode(err) !== 'cancelled') {
      reportError(err, t, httpStatus(err) === 409 ? t('chat.busy') : undefined);
    }
    throw err;
  }
}

export function composeBody(text: string, images: ImagePart[]): SendMessageRequest {
  if (images.length) {
    // Include a text part alongside images so the server receives both.
    const parts: UserInputPart[] = [
      ...(text.trim() ? ([{ type: 'text', text: text.trim() }] satisfies UserInputPart[]) : []),
      ...images,
    ];
    return { parts };
  }
  const body: SendMessageRequest = {};
  if (text.trim()) body.text = text.trim();
  return body;
}

export async function cancelTurn(client: NeoClient, t: TranslateFn): Promise<void> {
  const turn = useTimeline.getState().turn;
  const pending = pendingSends.get(client);
  if (pending) pending.cancelled = true;
  try {
    await client.timeline.cancel(turn?.turnId);
  } catch (err) {
    reportError(err, t);
  }
}

/** Resend the user message that led to `assistant` (after an error or a stop). */
export async function retryTurn(client: NeoClient, assistant: Message, t: TranslateFn): Promise<void> {
  const messages = useTimeline.getState().messages;
  const idx = messages.findIndex((m) => m.id === assistant.id);
  const user = [...messages.slice(0, idx)].reverse().find(
    (m) => m.role === 'user' && (m.episodeId ?? m.conversationId) === (assistant.episodeId ?? assistant.conversationId) && (assistant.turnId == null || m.turnId === assistant.turnId),
  );
  if (!user) {
    pushToast({ tone: 'warning', title: t('chat.retry_unavailable') });
    return;
  }
  const text = textOf(user.parts);
  const images = user.parts.filter((p): p is Extract<UserInputPart, { type: 'image' }> => p.type === 'image');
  if (!text.trim() && !images.length) {
    pushToast({ tone: 'warning', title: t('chat.retry_unavailable') });
    return;
  }
  await sendMessage(client, composeBody(text, images), t).catch(() => undefined);
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
  input: { messageId: string; uiId: string; action: UIAction; values?: Record<string, unknown> },
  t: TranslateFn,
  askConfirm?: AskUiActionConfirm,
): Promise<void> {
  const epoch = currentSessionEpoch();
  const request: UiActionRequest = { messageId: input.messageId, uiId: input.uiId, actionId: input.action.id };
  if (input.values) request.values = input.values;
  const send = async (body: UiActionRequest): Promise<UiActionResponse> => {
    try {
      const transition = waitForPrivacy(client);
      if (transition) await transition;
      if (!isCurrentSession(epoch)) throw new UiActionCancelled();
      return await client.timeline.uiAction(body);
    } catch (err) {
      if (isCurrentSession(epoch)) reportError(err, t);
      throw err;
    }
  };

  let res = await send(request);
  if (!isCurrentSession(epoch)) return;
  let freshAttempts = 0;
  while (res.kind === 'confirm') {
    const approved = askConfirm ? await askConfirm(res.confirmation) : false;
    if (!isCurrentSession(epoch)) return;
    if (!approved) throw new UiActionCancelled();
    try {
      const transition = waitForPrivacy(client);
      if (transition) await transition;
      if (!isCurrentSession(epoch)) return;
      res = await client.timeline.uiAction({ ...request, confirmationToken: res.confirmation.token });
      if (!isCurrentSession(epoch)) return;
    } catch (err) {
      if (!isCurrentSession(epoch)) return;
      const status = httpStatus(err);
      if ((status === 400 || status === 409) && freshAttempts < 1) {
        freshAttempts++;
        pushToast({ tone: 'warning', title: t('chat.action_confirm_expired') });
        res = await send(request);
        if (!isCurrentSession(epoch)) return;
        continue;
      }
      reportError(err, t);
      throw err;
    }
  }

  const quietWidget = input.action.id.startsWith(UI_ACTION_ID_PREFIX + 'change.apply:');
  switch (res.kind) {
    case 'turn':
      applyTurnResponse(res);
      return;
    case 'tool':
      if (res.isError) {
        const error = typeof res.output === 'object' && res.output !== null && 'error' in res.output && typeof res.output.error === 'string' ? res.output.error : undefined;
        // The changes widget shows each item's result in its own row.
        if (!quietWidget) pushToast({ tone: 'error', title: error ?? res.summary ?? t('chat.action_failed') });
        throw new Error(error ?? res.summary ?? 'tool failed');
      }
      // Quiet success for live widgets (the widget itself updates); others get a confirmation.
      if (!quietWidget && (!/^((?:__neo:)?task\.toggle|(?:__neo:)?reminder\.|(?:__neo:)?memory\.)/.test(input.action.id) || res.summary)) {
        pushToast({ tone: 'success', title: res.summary ?? t('chat.action_done'), icon: 'check-circle' });
      }
      if (input.action.id.startsWith(UI_ACTION_ID_PREFIX + 'memory.') || (input.action.kind === 'tool' && /memory|forget|remember/.test(input.action.tool))) {
        bumpMemoryVersion();
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
export async function respondToConfirmation(client: NeoClient, confirmationId: string, decision: ConfirmationDecision, t: TranslateFn): Promise<void> {
  const epoch = currentSessionEpoch();
  const confirmation = useTimeline.getState().confirmations.find((c) => c.id === confirmationId);
  try {
    const transition = waitForPrivacy(client);
    if (transition) await transition;
    if (!isCurrentSession(epoch)) return;
    await client.confirmations.respond(confirmationId, decision);
    if (!isCurrentSession(epoch)) return;
  } catch (err) {
    if (!isCurrentSession(epoch)) return;
    if (httpStatus(err) === 404) pushToast({ tone: 'warning', title: t('chat.confirmation_expired') });
    else {
      reportError(err, t);
      throw err;
    }
  }
  dismissToastKey(`confirm:${confirmationId}`);
  if (confirmation) {
    applyTimelineEvent({ type: 'tool.confirmation_resolved', conversationId: confirmation.conversationId, episodeId: confirmation.episodeId, turnId: confirmation.turnId, confirmationId: confirmation.id, toolCallId: confirmation.toolCallId, approved: decision.approve, reason: 'user' });
  }
}

/** Privacy transitions finish before sends, generated actions or approvals run. */
export async function setOffRecord(client: NeoClient, on: boolean, t: TranslateFn): Promise<void> {
  const epoch = currentSessionEpoch();
  const current = useTimeline.getState();
  if (current.startingOffRecord || current.endingOffRecord || current.offRecord === on) return;
  if (on) {
    setTimeline((entry) => ({ ...entry, startingOffRecord: true, privacyRevision: entry.privacyRevision + 1 }));
    const revision = useTimeline.getState().privacyRevision;
    try {
      const starting = client.timeline.startOffRecord();
      offRecordTransitions.set(client, starting);
      const state = await starting;
      if (isCurrentSession(epoch) && useTimeline.getState().privacyRevision === revision) applyOffRecordState(state);
    } catch (error) {
      if (isCurrentSession(epoch)) {
        if (useTimeline.getState().privacyRevision === revision) setTimeline((entry) => ({ ...entry, offRecord: false }));
        reportError(error, t, t('timeline.off_record_start_error'));
      }
      throw error;
    } finally {
      offRecordTransitions.delete(client);
      if (isCurrentSession(epoch)) setTimeline((entry) => ({ ...entry, startingOffRecord: false }));
    }
    return;
  }
  setTimeline((entry) => ({ ...entry, endingOffRecord: true, privacyRevision: entry.privacyRevision + 1 }));
  const revision = useTimeline.getState().privacyRevision;
  try {
    const pending = pendingSends.get(client);
    if (pending?.offRecord) {
      pending.cancelled = true;
      await client.timeline.cancel();
      await pending.settled;
    }
    if (!isCurrentSession(epoch)) return;
    await endTimelineOffRecord(client);
    if (!isCurrentSession(epoch)) return;
    setTimeline((entry) => entry.privacyRevision === revision || !entry.offRecord
      ? { ...withoutPrivateEpisodes(entry), offRecord: false, offRecordLoaded: true, endingOffRecord: false, privacyRevision: entry.privacyRevision + 1 }
      : { ...entry, endingOffRecord: false });
  } catch (error) {
    if (isCurrentSession(epoch)) {
      setTimeline((entry) => ({ ...entry, endingOffRecord: false }));
      reportError(error, t);
    }
    throw error;
  }
  const refresh = async () => {
    if (!isCurrentSession(epoch, client)) return;
    try {
      // A fetched boundary cannot distinguish new private episodes from legacy ones.
      await loadTimeline(client);
    } catch (error) {
      if (!isCurrentSession(epoch, client)) return;
      pushToast({ tone: 'error', title: t('timeline.load_error'), body: errorMessage(error, t),
        actions: [{ label: t('common.retry'), onClick: () => { void refresh(); } }] });
    }
  };
  await refresh();
}

export type AskDeleteConfirm = ConfirmFn;

async function finishDeletion(client: NeoClient, result: TimelineDeleteResult, t: TranslateFn, confirm: ConfirmFn, epoch: number): Promise<void> {
  if (!isCurrentSession(epoch)) return;
  setTimeline((entry) => withoutMessages(entry, result.messageIds));
  if (result.derivedMemories === 0) return;
  const forget = await confirm({ title: t('timeline.forget_title'), message: t('timeline.forget_text', { n: result.derivedMemories }),
    confirmLabel: t('timeline.forget_memories', { n: result.derivedMemories }), danger: true });
  if (!forget || !isCurrentSession(epoch)) return;
  await client.memory.forgetBySource(result.messageIds);
  if (isCurrentSession(epoch)) bumpMemoryVersion();
}

export async function deleteMessage(client: NeoClient, id: string, t: TranslateFn, confirm: ConfirmFn): Promise<boolean> {
  const epoch = currentSessionEpoch();
  const approved = await confirm({ title: t('timeline.delete_message_title'), message: t('timeline.delete_message_text'), confirmLabel: t('common.delete'), danger: true });
  if (!approved || !isCurrentSession(epoch)) return false;
  try {
    const result = await client.timeline.deleteMessage(id);
    if (!isCurrentSession(epoch)) return false;
    await finishDeletion(client, result, t, confirm, epoch);
    return isCurrentSession(epoch);
  } catch (error) {
    if (isCurrentSession(epoch)) reportError(error, t);
    throw error;
  }
}

export async function deleteRange(client: NeoClient, range: { from?: string; to?: string }, t: TranslateFn, confirm: ConfirmFn): Promise<boolean> {
  const epoch = currentSessionEpoch();
  const settings = useSession.getState().settings;
  const formatter = new Intl.DateTimeFormat(settings?.locale === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: settings?.timezone ?? 'UTC' });
  const detail = [range.from ? formatter.format(new Date(range.from)) : '…', range.to ? formatter.format(new Date(range.to)) : '…'].join(' – ');
  const approved = await confirm({ title: t('timeline.delete_range_title'), message: t('timeline.delete_range_text'), detail, confirmLabel: t('common.delete'), danger: true });
  if (!approved || !isCurrentSession(epoch)) return false;
  try {
    const result = await client.timeline.deleteRange(range);
    if (!isCurrentSession(epoch)) return false;
    await finishDeletion(client, result, t, confirm, epoch);
    return isCurrentSession(epoch);
  } catch (error) {
    if (isCurrentSession(epoch)) reportError(error, t);
    throw error;
  }
}
