/**
 * Conversations and their message caches.
 *
 * `reduceConversations(state, event)` is a pure reducer for every AgentEvent
 * plus `conversation.deleted`; the zustand store just applies it. Message
 * parts are rebuilt exactly like core builds them: text/reasoning deltas
 * coalesce into the last part of their kind, `part.added` places finished parts
 * at their index, and `message.completed` replaces the message wholesale.
 */
import { create } from 'zustand';
import type {
  AgentEvent,
  ContentPart,
  Conversation,
  ConversationWithMessages,
  ErrorShape,
  MemoryNodeSummary,
  Message,
  ModelRef,
  RecalledMemorySummary,
  ServerEvent,
  ToolConfirmation,
} from '@neo/protocol';
import { previewOf } from '@neo/protocol';

export interface TurnState {
  turnId: string;
  assistantMessageId: string;
  userMessageId: string | null;
  model: ModelRef | null;
  startedAt: number;
}

/** What NEO remembered after a turn (memory.written). */
export interface MemoryNotice {
  turnId: string;
  created: MemoryNodeSummary[];
  updated: MemoryNodeSummary[];
  pending: MemoryNodeSummary[];
  /** Local decisions on pending items. */
  resolved: Record<string, 'approved' | 'rejected'>;
}

export interface ConversationEntry {
  messages: Message[];
  hasMore: boolean;
  loaded: boolean;
  turn: TurnState | null;
  confirmations: ToolConfirmation[];
  /** Recalled memories by turn id. */
  recalled: Record<string, RecalledMemorySummary[]>;
  /** Memory write-back notices by turn id. */
  notices: Record<string, MemoryNotice>;
  lastError: ErrorShape | null;
}

export interface ConversationsData {
  conversations: Record<string, Conversation>;
  entries: Record<string, ConversationEntry>;
}

export interface ConversationsState extends ConversationsData {
  listLoaded: boolean;
  archivedLoaded: boolean;
}

export function emptyEntry(): ConversationEntry {
  return { messages: [], hasMore: false, loaded: false, turn: null, confirmations: [], recalled: {}, notices: {}, lastError: null };
}

// ───────────────────────────── message helpers ─────────────────────────────

function upsertMessage(messages: Message[], message: Message): Message[] {
  const i = messages.findIndex((m) => m.id === message.id);
  if (i >= 0) {
    const next = messages.slice();
    next[i] = message;
    return next;
  }
  // Keep chronological order (events normally arrive in order, so this is an append).
  const next = [...messages, message];
  if (next.length > 1 && next[next.length - 2]!.createdAt > message.createdAt) next.sort((a, b) => a.createdAt - b.createdAt);
  return next;
}

function updateMessage(messages: Message[], id: string, fn: (m: Message) => Message): Message[] {
  const i = messages.findIndex((m) => m.id === id);
  if (i < 0) return messages;
  const next = messages.slice();
  next[i] = fn(messages[i]!);
  return next;
}

function placeholder(conversationId: string, id: string, turnId: string, model: ModelRef | null, createdAt: number): Message {
  return { id, conversationId, role: 'assistant', parts: [], status: 'streaming', createdAt, turnId, model };
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

function ensureAssistant(entry: ConversationEntry, conversationId: string, messageId: string): Message[] {
  if (entry.messages.some((m) => m.id === messageId)) return entry.messages;
  const turn = entry.turn;
  return upsertMessage(entry.messages, placeholder(conversationId, messageId, turn?.turnId ?? '', turn?.model ?? null, Date.now()));
}

// ───────────────────────────── the reducer ─────────────────────────────

function withEntry(state: ConversationsData, id: string, fn: (entry: ConversationEntry) => ConversationEntry): ConversationsData {
  const entry = state.entries[id] ?? emptyEntry();
  const next = fn(entry);
  if (next === entry && state.entries[id]) return state;
  return { ...state, entries: { ...state.entries, [id]: next } };
}

function touchConversation(state: ConversationsData, id: string, message: Message): ConversationsData {
  const conv = state.conversations[id];
  if (!conv) return state;
  const preview = previewOf(message.parts) || conv.preview;
  const at = Math.max(conv.lastMessageAt ?? 0, message.createdAt);
  return { ...state, conversations: { ...state.conversations, [id]: { ...conv, lastMessageAt: at, updatedAt: Math.max(conv.updatedAt, at), preview } } };
}

function finishTurn(entry: ConversationEntry, turnId: string, apply: (m: Message) => Message): ConversationEntry {
  const assistantId = entry.turn?.turnId === turnId ? entry.turn.assistantMessageId : entry.messages.find((m) => m.turnId === turnId && m.role === 'assistant')?.id;
  const messages = assistantId ? updateMessage(entry.messages, assistantId, apply) : entry.messages;
  return {
    ...entry,
    messages,
    turn: entry.turn && entry.turn.turnId !== turnId ? entry.turn : null,
    confirmations: entry.confirmations.filter((c) => c.turnId !== turnId),
  };
}

export function reduceConversations(state: ConversationsData, event: AgentEvent | ServerEvent): ConversationsData {
  switch (event.type) {
    case 'conversation.updated':
      return { ...state, conversations: { ...state.conversations, [event.conversation.id]: event.conversation } };

    case 'conversation.deleted': {
      const conversations = { ...state.conversations };
      const entries = { ...state.entries };
      delete conversations[event.conversationId];
      delete entries[event.conversationId];
      return { conversations, entries };
    }

    case 'turn.started': {
      const next = withEntry(state, event.conversationId, (entry) => {
        let messages = upsertMessage(entry.messages, event.userMessage);
        if (!messages.some((m) => m.id === event.assistantMessageId)) {
          messages = upsertMessage(messages, placeholder(event.conversationId, event.assistantMessageId, event.turnId, event.model, Math.max(Date.now(), event.userMessage.createdAt)));
        } else {
          messages = updateMessage(messages, event.assistantMessageId, (m) => ({ ...m, turnId: event.turnId, model: event.model }));
        }
        return {
          ...entry,
          messages,
          turn: { turnId: event.turnId, assistantMessageId: event.assistantMessageId, userMessageId: event.userMessage.id, model: event.model, startedAt: Date.now() },
          lastError: null,
        };
      });
      return touchConversation(next, event.conversationId, event.userMessage);
    }

    case 'text.delta':
    case 'reasoning.delta': {
      const kind = event.type === 'text.delta' ? 'text' : 'reasoning';
      return withEntry(state, event.conversationId, (entry) => ({
        ...entry,
        messages: updateMessage(ensureAssistant(entry, event.conversationId, event.messageId), event.messageId, (m) => ({ ...m, parts: appendDelta(m.parts, kind, event.text) })),
      }));
    }

    case 'part.added':
      return withEntry(state, event.conversationId, (entry) => ({
        ...entry,
        messages: updateMessage(ensureAssistant(entry, event.conversationId, event.messageId), event.messageId, (m) => ({ ...m, parts: placePart(m.parts, event.index, event.part) })),
      }));

    case 'message.completed': {
      const next = withEntry(state, event.conversationId, (entry) => ({ ...entry, messages: upsertMessage(entry.messages, event.message) }));
      return touchConversation(next, event.conversationId, event.message);
    }

    case 'tool.confirmation': {
      // Keyed by the server nonce (`id`). A newer request for the same call of
      // the same turn replaces the old one; provider call ids alone can repeat
      // across turns, so they never identify a confirmation on their own.
      const next = event.confirmation;
      return withEntry(state, event.conversationId, (entry) => ({
        ...entry,
        confirmations: [...entry.confirmations.filter((c) => c.id !== next.id && !(c.turnId === next.turnId && c.toolCallId === next.toolCallId)), next],
      }));
    }

    case 'tool.confirmation_resolved':
      return withEntry(state, event.conversationId, (entry) => ({
        ...entry,
        confirmations: entry.confirmations.filter((c) =>
          event.confirmationId ? c.id !== event.confirmationId : !(c.toolCallId === event.toolCallId && c.turnId === event.turnId),
        ),
      }));

    case 'memory.recalled':
      return withEntry(state, event.conversationId, (entry) => ({ ...entry, recalled: { ...entry.recalled, [event.turnId]: event.items } }));

    case 'memory.written':
      if (!event.created.length && !event.updated.length && !event.pending.length) return state;
      return withEntry(state, event.conversationId, (entry) => ({
        ...entry,
        notices: { ...entry.notices, [event.turnId]: { turnId: event.turnId, created: event.created, updated: event.updated, pending: event.pending, resolved: {} } },
      }));

    case 'turn.finished':
      return withEntry(state, event.conversationId, (entry) =>
        finishTurn(entry, event.turnId, (m) => {
          if (m.status !== 'streaming') return m;
          return { ...m, status: event.stopReason === 'cancelled' ? 'cancelled' : 'complete', usage: event.usage ?? m.usage ?? null };
        }),
      );

    case 'turn.failed':
      return withEntry(state, event.conversationId, (entry) => ({
        ...finishTurn(entry, event.turnId, (m) => (m.status === 'error' ? m : { ...m, status: 'error', error: m.error ?? event.error })),
        lastError: event.error,
      }));

    case 'tool.started':
    case 'tool.finished':
      // Chips are derived from the tool_call / tool_result parts.
      return state;

    default:
      return state;
  }
}

/**
 * Merge a freshly fetched conversation into the cache (initial load, refetch
 * after a reconnect or a seq gap). Server messages win; local messages newer
 * than the fetched page (an in-flight turn) are kept. The running turn is
 * restored from a streaming assistant message.
 */
export function mergeFetched(entry: ConversationEntry, data: ConversationWithMessages): ConversationEntry {
  const fetched = [...data.messages].sort((a, b) => a.createdAt - b.createdAt);
  const ids = new Set(fetched.map((m) => m.id));
  const newest = fetched.length ? fetched[fetched.length - 1]!.createdAt : 0;
  const extra = entry.messages.filter((m) => !ids.has(m.id) && m.createdAt >= newest);
  const messages = [...fetched, ...extra];
  const streaming = [...messages].reverse().find((m) => m.role === 'assistant' && m.status === 'streaming');
  let turn = entry.turn;
  if (streaming && streaming.turnId) {
    turn = turn && turn.assistantMessageId === streaming.id ? turn : { turnId: streaming.turnId, assistantMessageId: streaming.id, userMessageId: null, model: streaming.model ?? null, startedAt: streaming.createdAt };
  } else if (turn && !messages.some((m) => m.id === turn!.assistantMessageId && m.status === 'streaming')) {
    turn = null;
  }
  return { ...entry, messages, hasMore: data.hasMore, loaded: true, turn };
}

/** Older page prepended (when the user scrolls up). */
export function prependOlder(entry: ConversationEntry, data: ConversationWithMessages): ConversationEntry {
  const ids = new Set(entry.messages.map((m) => m.id));
  const older = data.messages.filter((m) => !ids.has(m.id)).sort((a, b) => a.createdAt - b.createdAt);
  return { ...entry, messages: [...older, ...entry.messages], hasMore: data.hasMore };
}

/** Sort for the sidebar: pinned first, then most recent activity. */
export function sortConversations(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt));
}

// ───────────────────────────── store ─────────────────────────────

export const useConversations = create<ConversationsState>(() => ({
  conversations: {},
  entries: {},
  listLoaded: false,
  archivedLoaded: false,
}));

export function applyConversationEvent(event: AgentEvent | ServerEvent): void {
  useConversations.setState((s) => {
    const next = reduceConversations(s, event);
    return next === s ? s : { ...s, ...next };
  });
}

export function upsertConversation(conv: Conversation): void {
  useConversations.setState((s) => ({ conversations: { ...s.conversations, [conv.id]: conv } }));
}

export function upsertConversations(list: Conversation[], flags: Partial<Pick<ConversationsState, 'listLoaded' | 'archivedLoaded'>> = {}): void {
  useConversations.setState((s) => {
    const conversations = { ...s.conversations };
    for (const c of list) conversations[c.id] = c;
    return { conversations, ...flags };
  });
}

export function removeConversation(id: string): void {
  applyConversationEvent({ type: 'conversation.deleted', conversationId: id });
}

export function setEntry(id: string, fn: (entry: ConversationEntry) => ConversationEntry): void {
  useConversations.setState((s) => ({ entries: { ...s.entries, [id]: fn(s.entries[id] ?? emptyEntry()) } }));
}

/** The pending confirmation a `tool.confirmation_resolved` event refers to (by nonce when the server sends one). */
export function findConfirmation(conversationId: string, turnId: string, toolCallId: string, confirmationId?: string): ToolConfirmation | undefined {
  return useConversations
    .getState()
    .entries[conversationId]?.confirmations.find((c) => (confirmationId ? c.id === confirmationId : c.turnId === turnId && c.toolCallId === toolCallId));
}

/** Replace pending confirmations for every conversation (after a refetch). */
export function setAllConfirmations(list: ToolConfirmation[]): void {
  useConversations.setState((s) => {
    const entries = { ...s.entries };
    const byConv = new Map<string, ToolConfirmation[]>();
    for (const c of list) byConv.set(c.conversationId, [...(byConv.get(c.conversationId) ?? []), c]);
    for (const [id, entry] of Object.entries(entries)) if (entry.confirmations.length && !byConv.has(id)) entries[id] = { ...entry, confirmations: [] };
    for (const [id, confs] of byConv) entries[id] = { ...(entries[id] ?? emptyEntry()), confirmations: confs };
    return { entries };
  });
}

export function resolveNoticeItem(conversationId: string, turnId: string, nodeId: string, decision: 'approved' | 'rejected'): void {
  setEntry(conversationId, (entry) => {
    const notice = entry.notices[turnId];
    if (!notice) return entry;
    return { ...entry, notices: { ...entry.notices, [turnId]: { ...notice, resolved: { ...notice.resolved, [nodeId]: decision } } } };
  });
}
