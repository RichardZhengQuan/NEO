/** One continuous timeline, with episode provenance kept on every message. */
import { create } from 'zustand';
import type { NeoClient } from '@neo/client';
import type {
  AgentEvent,
  ContentPart,
  Episode,
  EpisodeBoundary,
  ErrorShape,
  MemoryNodeSummary,
  Message,
  ModelRef,
  OffRecordState,
  RecalledMemorySummary,
  ServerEvent,
  TimelinePage,
  ToolConfirmation,
} from '@neo/protocol';

export interface TurnState {
  turnId: string;
  assistantMessageId: string;
  userMessageId: string | null;
  model: ModelRef | null;
  startedAt: number;
}

export interface MemoryNotice {
  turnId: string;
  created: MemoryNodeSummary[];
  updated: MemoryNodeSummary[];
}

export type TimelineEpisode = EpisodeBoundary & Partial<Pick<Episode, 'ephemeral' | 'closedAt' | 'lastMessageAt'>> & { firstMessageId?: string; awaitingFirstMessage?: boolean };

export interface TimelineEntry {
  messages: Message[];
  episodes: Record<string, TimelineEpisode>;
  nextCursor: string | null;
  hasMore: boolean;
  viewAround?: string;
  loaded: boolean;
  turn: TurnState | null;
  confirmations: ToolConfirmation[];
  recalled: Record<string, RecalledMemorySummary[]>;
  notices: Record<string, MemoryNotice>;
  lastError: ErrorShape | null;
  deletedEpisodes: Record<string, true>;
  deletedMessageIds: Record<string, true>;
  offRecord: boolean;
  offRecordLoaded: boolean;
  startingOffRecord: boolean;
  endingOffRecord: boolean;
  privacyRevision: number;
  privacyScope?: string;
}

export type TimelineState = TimelineEntry;

export function emptyEntry(): TimelineEntry {
  return { messages: [], episodes: {}, nextCursor: null, hasMore: false, loaded: false, turn: null,
    confirmations: [], recalled: {}, notices: {}, lastError: null, deletedEpisodes: {}, deletedMessageIds: {},
    offRecord: false, offRecordLoaded: false, startingOffRecord: false, endingOffRecord: false, privacyRevision: 0 };
}

function upsertMessage(messages: Message[], message: Message): Message[] {
  const i = messages.findIndex((m) => m.id === message.id);
  if (i >= 0) {
    const next = messages.slice();
    next[i] = message;
    return next;
  }
  // Preserve episode blocks; stream events append to the current episode.
  return [...messages, message];
}

function updateMessage(messages: Message[], id: string, fn: (m: Message) => Message): Message[] {
  const i = messages.findIndex((m) => m.id === id);
  if (i < 0) return messages;
  const next = messages.slice();
  next[i] = fn(messages[i]!);
  return next;
}

function placeholder(episodeId: string, id: string, turnId: string, model: ModelRef | null, createdAt: number): Message {
  return { id, conversationId: episodeId, episodeId, role: 'assistant', parts: [], status: 'streaming', createdAt, turnId, model };
}

/** Append a text/reasoning delta, coalescing into the last part of the same kind. */
export function appendDelta(parts: ContentPart[], kind: 'text' | 'reasoning', text: string): ContentPart[] {
  const last = parts[parts.length - 1];
  if (last && last.type === kind) {
    const next = parts.slice();
    next[next.length - 1] = { ...last, text: last.text + text };
    return next;
  }
  return [...parts, kind === 'text' ? { type: 'text', text } : { type: 'reasoning', text }];
}

/** Place a finished part at `index` (replacing a placeholder there), never leaving holes. */
export function placePart(parts: ContentPart[], index: number, part: ContentPart): ContentPart[] {
  const next = parts.slice();
  if (index >= 0 && index < next.length) next[index] = part;
  else next.push(part);
  return next;
}

function ensureAssistant(entry: TimelineEntry, messageId: string, episodeId: string, turnId: string): Message[] {
  if (entry.messages.some((m) => m.id === messageId)) return entry.messages;
  const turn = entry.turn;
  return upsertMessage(entry.messages, placeholder(episodeId, messageId, turn?.turnId ?? turnId, turn?.model ?? null, Date.now()));
}

function finishTurn(entry: TimelineEntry, turnId: string, apply: (m: Message) => Message): TimelineEntry {
  const assistantId = entry.turn?.turnId === turnId ? entry.turn.assistantMessageId : entry.messages.find((m) => m.turnId === turnId && m.role === 'assistant')?.id;
  const messages = assistantId ? updateMessage(entry.messages, assistantId, apply) : entry.messages;
  return {
    ...entry,
    messages,
    turn: entry.turn && entry.turn.turnId !== turnId ? entry.turn : null,
    confirmations: entry.confirmations.filter((c) => c.turnId !== turnId),
  };
}

/** Remove deleted messages immediately and ignore delayed stream completions. */
export function withoutMessages(entry: TimelineEntry, ids: readonly string[]): TimelineEntry {
  const removed = new Set(ids);
  const deletedMessageIds = { ...entry.deletedMessageIds };
  for (const id of ids) deletedMessageIds[id] = true;
  return { ...entry, deletedMessageIds,
    messages: entry.messages.filter((message) => !removed.has(message.id)),
    turn: entry.turn && (removed.has(entry.turn.assistantMessageId) || removed.has(entry.turn.userMessageId ?? '')) ? null : entry.turn,
    confirmations: entry.confirmations.filter((confirmation) => !removed.has(confirmation.messageId)) };
}

export function reduceTimeline(entry: TimelineEntry, event: AgentEvent | ServerEvent): TimelineEntry {
  if ('episodeId' in event && entry.deletedEpisodes[event.episodeId] && event.type !== 'conversation.deleted') return entry;
  if ('messageId' in event && entry.deletedMessageIds[event.messageId]) return entry;
  switch (event.type) {
    case 'timeline.off_record':
      return { ...(event.active ? entry : withoutPrivateEpisodes(entry)), offRecord: event.active, offRecordLoaded: true, privacyRevision: entry.privacyRevision + 1 };
    case 'episode.started':
    case 'conversation.updated': {
      const episode = event.type === 'episode.started' ? event.episode : event.conversation;
      return { ...entry, episodes: { ...entry.episodes, [episode.id]: { ...entry.episodes[episode.id], ...episode, episodeId: episode.id, ...(event.type === 'episode.started' ? { awaitingFirstMessage: true } : {}) } } };
    }
    case 'conversation.deleted': {
      const episodes = { ...entry.episodes };
      delete episodes[event.episodeId];
      const removed = entry.messages.filter((message) => (message.episodeId ?? message.conversationId) === event.episodeId);
      const turnIds = new Set(removed.flatMap((message) => message.turnId ? [message.turnId] : []));
      return { ...withoutMessages(entry, removed.map((message) => message.id)), episodes,
        deletedEpisodes: { ...entry.deletedEpisodes, [event.episodeId]: true },
        confirmations: entry.confirmations.filter((confirmation) => confirmation.episodeId !== event.episodeId),
        recalled: Object.fromEntries(Object.entries(entry.recalled).filter(([turnId]) => !turnIds.has(turnId))),
        notices: Object.fromEntries(Object.entries(entry.notices).filter(([turnId]) => !turnIds.has(turnId))) };
    }
    case 'turn.started': {
      if (entry.deletedMessageIds[event.userMessage.id] || entry.deletedMessageIds[event.assistantMessageId]) return entry;
      let messages = upsertMessage(entry.messages, event.userMessage);
      const existing = messages.find((message) => message.id === event.assistantMessageId);
      if (existing && existing.status !== 'streaming') return { ...entry, messages };
      if (!existing) messages = upsertMessage(messages, placeholder(event.episodeId, event.assistantMessageId, event.turnId, event.model, Math.max(Date.now(), event.userMessage.createdAt)));
      else messages = updateMessage(messages, event.assistantMessageId, (message) => ({ ...message, turnId: event.turnId, model: event.model }));
      const episode = entry.episodes[event.episodeId];
      const episodes = episode?.awaitingFirstMessage ? { ...entry.episodes, [event.episodeId]: { ...episode, firstMessageId: event.userMessage.id, awaitingFirstMessage: false } } : entry.episodes;
      return { ...entry, messages, episodes,
        turn: { turnId: event.turnId, assistantMessageId: event.assistantMessageId, userMessageId: event.userMessage.id, model: event.model, startedAt: Date.now() },
        lastError: null };
    }
    case 'text.delta':
    case 'reasoning.delta': {
      const message = entry.messages.find((item) => item.id === event.messageId);
      if (message && message.status !== 'streaming') return entry;
      const kind = event.type === 'text.delta' ? 'text' : 'reasoning';
      return { ...entry, messages: updateMessage(ensureAssistant(entry, event.messageId, event.episodeId, event.turnId), event.messageId,
        (item) => ({ ...item, parts: appendDelta(item.parts, kind, event.text) })) };
    }
    case 'part.added': {
      const message = entry.messages.find((item) => item.id === event.messageId);
      if (message && message.status !== 'streaming') return entry;
      return { ...entry, messages: updateMessage(ensureAssistant(entry, event.messageId, event.episodeId, event.turnId), event.messageId,
        (item) => ({ ...item, parts: placePart(item.parts, event.index, event.part) })) };
    }
    case 'message.completed':
      return entry.deletedMessageIds[event.message.id] ? entry : { ...entry, messages: upsertMessage(entry.messages, event.message) };
    case 'tool.confirmation': {
      const next = event.confirmation;
      if (entry.deletedMessageIds[next.messageId]) return entry;
      return { ...entry, confirmations: [...entry.confirmations.filter((confirmation) => confirmation.id !== next.id && !(confirmation.turnId === next.turnId && confirmation.toolCallId === next.toolCallId)), next] };
    }
    case 'tool.confirmation_resolved':
      return { ...entry, confirmations: entry.confirmations.filter((confirmation) => event.confirmationId ? confirmation.id !== event.confirmationId : !(confirmation.toolCallId === event.toolCallId && confirmation.turnId === event.turnId)) };
    case 'memory.recalled':
      return { ...entry, recalled: { ...entry.recalled, [event.turnId]: event.items } };
    case 'memory.written':
      return !event.created.length && !event.updated.length ? entry : { ...entry,
        notices: { ...entry.notices, [event.turnId]: { turnId: event.turnId, created: event.created, updated: event.updated } } };
    case 'turn.finished':
      return finishTurn(entry, event.turnId, (message) => message.status !== 'streaming' ? message : { ...message,
        status: event.stopReason === 'cancelled' ? 'cancelled' : 'complete', usage: event.usage ?? message.usage ?? null });
    case 'turn.failed':
      return { ...finishTurn(entry, event.turnId, (message) => message.status === 'error' ? message : { ...message, status: 'error', error: message.error ?? event.error }), lastError: event.error };
    default:
      return entry;
  }
}

function mergeEpisodes(entry: TimelineEntry, page: TimelinePage): Record<string, TimelineEpisode> {
  const episodes = { ...entry.episodes };
  for (const episode of page.episodes) {
    if (!entry.deletedEpisodes[episode.episodeId]) episodes[episode.episodeId] = { ...episodes[episode.episodeId], ...episode, firstMessageId: page.items.find((message) => message.episodeId === episode.episodeId)?.id, awaitingFirstMessage: false };
  }
  return episodes;
}

/** Server episode blocks retain their order, even when legacy timestamps overlap. */
export function mergeFetched(entry: TimelineEntry, page: TimelinePage, snapshotIds?: ReadonlySet<string>): TimelineEntry {
  const fetched = page.items.filter((message) => !entry.deletedMessageIds[message.id] && !entry.deletedEpisodes[message.episodeId]);
  const ids = new Set(fetched.map((message) => message.id));
  const newest = fetched.at(-1)?.createdAt ?? 0;
  const extra = entry.messages.filter((message) => !ids.has(message.id) && !snapshotIds?.has(message.id) && message.createdAt >= newest);
  const messages = [...fetched, ...extra];
  const streaming = [...messages].reverse().find((message) => message.role === 'assistant' && message.status === 'streaming');
  let turn = entry.turn;
  if (streaming?.turnId) turn = turn?.assistantMessageId === streaming.id ? turn : { turnId: streaming.turnId, assistantMessageId: streaming.id, userMessageId: null, model: streaming.model ?? null, startedAt: streaming.createdAt };
  else if (turn && !messages.some((message) => message.id === turn!.assistantMessageId && message.status === 'streaming')
    && (!entry.viewAround || fetched.some((message) => message.id === turn!.assistantMessageId))) turn = null;
  return { ...entry, messages, episodes: mergeEpisodes(entry, page), nextCursor: page.nextCursor, hasMore: page.nextCursor !== null, loaded: true, turn };
}

export function prependOlder(entry: TimelineEntry, page: TimelinePage): TimelineEntry {
  const ids = new Set(entry.messages.map((message) => message.id));
  const older = page.items.filter((message) => !ids.has(message.id) && !entry.deletedMessageIds[message.id] && !entry.deletedEpisodes[message.episodeId]);
  return { ...entry, messages: [...older, ...entry.messages], episodes: mergeEpisodes(entry, page), nextCursor: page.nextCursor, hasMore: page.nextCursor !== null };
}

export function withoutPrivateEpisodes(entry: TimelineEntry): TimelineEntry {
  let next = entry;
  for (const episode of Object.values(entry.episodes)) {
    if (episode.ephemeral) next = reduceTimeline(next, { type: 'conversation.deleted', episodeId: episode.episodeId, conversationId: episode.episodeId });
  }
  return next;
}

export function applyOffRecordState(state: OffRecordState): void {
  setTimeline((entry) => {
    const next = state.active ? entry : withoutPrivateEpisodes(entry);
    const episodes = state.active && state.episodeId ? { ...next.episodes,
      [state.episodeId]: { ...next.episodes[state.episodeId], episodeId: state.episodeId, startedAt: state.startedAt ?? 0, offRecord: true, ephemeral: true } } : next.episodes;
    return { ...next, episodes, offRecord: state.active, offRecordLoaded: true, privacyRevision: entry.privacyRevision + 1 };
  });
}

export const useTimeline = create<TimelineState>(() => emptyEntry());

export function setTimeline(fn: (entry: TimelineEntry) => TimelineEntry): void {
  useTimeline.setState(fn);
  persistTimelinePrivacy();
}

export function applyTimelineEvent(event: AgentEvent | ServerEvent): void {
  setTimeline((entry) => reduceTimeline(entry, event));
}

export function findConfirmation(turnId: string, toolCallId: string, confirmationId?: string): ToolConfirmation | undefined {
  return useTimeline.getState().confirmations.find((confirmation) => confirmationId ? confirmation.id === confirmationId : confirmation.turnId === turnId && confirmation.toolCallId === toolCallId);
}

export function setAllConfirmations(confirmations: ToolConfirmation[]): void {
  setTimeline((entry) => ({ ...entry, confirmations: confirmations.filter((confirmation) => !entry.deletedEpisodes[confirmation.episodeId] && !entry.deletedMessageIds[confirmation.messageId]) }));
}

function privacyKey(scope: string): string { return `neo.timeline.off-record:${scope}`; }

function persistTimelinePrivacy(): void {
  const entry = useTimeline.getState();
  if (!entry.privacyScope || typeof sessionStorage === 'undefined') return;
  try {
    if (!entry.offRecord) sessionStorage.removeItem(privacyKey(entry.privacyScope));
    else sessionStorage.setItem(privacyKey(entry.privacyScope), JSON.stringify({
      active: true, episodes: Object.values(entry.episodes).filter((episode) => episode.ephemeral).map((episode) => episode.episodeId),
    }));
  } catch { /* Privacy still works when browser storage is unavailable. */ }
}

/** Cached appearance is replaced by the server state before privacy can change. */
export function resetTimeline(scope?: string): void {
  const entry = { ...emptyEntry(), privacyScope: scope };
  if (scope && typeof sessionStorage !== 'undefined') {
    try {
      const saved = JSON.parse(sessionStorage.getItem(privacyKey(scope)) ?? 'null') as { active?: unknown; episodes?: unknown } | null;
      entry.offRecord = saved?.active === true;
      if (entry.offRecord && Array.isArray(saved?.episodes)) {
        for (const id of saved.episodes) if (typeof id === 'string') entry.episodes[id] = { episodeId: id, startedAt: 0, offRecord: true, ephemeral: true };
      }
    } catch { /* An invalid preference starts with normal recording. */ }
  }
  useTimeline.setState(entry, true);
}

const streamingClients = new WeakMap<NeoClient, number>();

export function beginTimelineStream(client: NeoClient): () => void {
  streamingClients.set(client, (streamingClients.get(client) ?? 0) + 1);
  return () => {
    const count = (streamingClients.get(client) ?? 1) - 1;
    if (count) streamingClients.set(client, count);
    else streamingClients.delete(client);
  };
}

/** SSE already delivers these events while a fallback turn is streaming. */
export function isTimelineStreamEvent(client: NeoClient, event: ServerEvent): boolean {
  return streamingClients.has(client) && 'turnId' in event;
}
