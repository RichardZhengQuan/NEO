import { describe, expect, it } from 'vitest';
import type { AgentEvent, Episode, Message, TimelinePage, ToolConfirmation } from '@neo/protocol';
import { appendDelta, emptyEntry, mergeFetched, placePart, prependOlder, reduceTimeline, withoutMessages, type TimelineEntry } from './timeline.js';
import { recalledForMessage, recalledFromContext } from '../lib/context.js';

const C = 'conv_1';
const T = 'turn_1';
const A = 'msg_a';

function episode(over: Partial<Episode> = {}): Episode {
  return { id: C, kind: 'episode', offRecord: false, ephemeral: false, startedAt: 1, closedAt: null, lastMessageAt: null, ...over };
}

function page(items: Message[], hasMore = false): TimelinePage {
  return { items: items.map((message) => ({ ...message, episodeId: message.episodeId ?? message.conversationId })), episodes: [], nextCursor: hasMore ? 'older-cursor' : null };
}

const userMessage: Message = { id: 'msg_u', episodeId: C, conversationId: C, role: 'user', parts: [{ type: 'context', text: 'ctx' }, { type: 'text', text: 'Hello' }], createdAt: 100, status: 'complete', turnId: T };

function base(): TimelineEntry {
  return emptyEntry();
}

function run(events: AgentEvent[], state: TimelineEntry = base()): TimelineEntry {
  return events.reduce((s, e) => reduceTimeline(s, e), state);
}

const started: AgentEvent = { type: 'turn.started', episodeId: C, conversationId: C, turnId: T, userMessage, assistantMessageId: A, model: { provider: 'test', model: 'neo-test' } };

function assistant(state: TimelineEntry): Message {
  return state.messages.find((m) => m.id === A)!;
}

describe('reduceTimeline', () => {
  it('turn.started adds the user message, a streaming placeholder and the turn', () => {
    const s = run([started]);
    const entry = s;
    expect(entry.messages.map((m) => m.id)).toEqual(['msg_u', A]);
    expect(assistant(s)).toMatchObject({ role: 'assistant', status: 'streaming', parts: [], turnId: T, model: { provider: 'test' } });
    expect(entry.turn).toMatchObject({ turnId: T, assistantMessageId: A, userMessageId: 'msg_u' });
  });

  it('preserves optional sensitivity metadata in completed and fetched messages', () => {
    const sensitive: Message = {
      id: A, episodeId: C, conversationId: C, role: 'assistant', createdAt: 101, status: 'complete', sensitive: true,
      parts: [
        { type: 'tool_call', id: 'recall_1', name: 'recall', input: { query: 'health' } },
        { type: 'tool_result', toolCallId: 'recall_1', name: 'recall', output: { items: [] }, sensitive: true },
        { type: 'text', text: 'Private reply' },
      ],
    };
    const completed = run([started, { type: 'message.completed', episodeId: C, conversationId: C, turnId: T, message: sensitive }]);
    expect(assistant(completed)).toEqual(sensitive);
    const fetched = mergeFetched(emptyEntry(), page([userMessage, sensitive]));
    expect(fetched.messages[1]).toEqual(sensitive);
  });

  it('turn.started is idempotent (202 response + WS event)', () => {
    const s = run([started, started]);
    expect(s.messages).toHaveLength(2);
  });

  it('coalesces text deltas into the last text part', () => {
    const s = run([
      started,
      { type: 'text.delta', episodeId: C, conversationId: C, turnId: T, messageId: A, text: 'Hel' },
      { type: 'text.delta', episodeId: C, conversationId: C, turnId: T, messageId: A, text: 'lo' },
    ]);
    expect(assistant(s).parts).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('reasoning deltas build a reasoning part completed by part.added', () => {
    const s = run([
      started,
      { type: 'reasoning.delta', episodeId: C, conversationId: C, turnId: T, messageId: A, text: 'Let me ' },
      { type: 'reasoning.delta', episodeId: C, conversationId: C, turnId: T, messageId: A, text: 'think' },
      { type: 'part.added', episodeId: C, conversationId: C, turnId: T, messageId: A, index: 0, part: { type: 'reasoning', text: 'Let me think', provider: 'anthropic', data: 'sig' } },
      { type: 'text.delta', episodeId: C, conversationId: C, turnId: T, messageId: A, text: 'Answer' },
    ]);
    expect(assistant(s).parts).toEqual([
      { type: 'reasoning', text: 'Let me think', provider: 'anthropic', data: 'sig' },
      { type: 'text', text: 'Answer' },
    ]);
  });

  it('interleaves text, tool calls, results and ui parts in order', () => {
    const s = run([
      started,
      { type: 'text.delta', episodeId: C, conversationId: C, turnId: T, messageId: A, text: 'Sure. ' },
      { type: 'part.added', episodeId: C, conversationId: C, turnId: T, messageId: A, index: 1, part: { type: 'tool_call', id: 'tc_1', name: 'create_reminder', input: {} } },
      { type: 'tool.started', episodeId: C, conversationId: C, turnId: T, messageId: A, toolCallId: 'tc_1', name: 'create_reminder', title: 'Create reminder', input: {} },
      { type: 'part.added', episodeId: C, conversationId: C, turnId: T, messageId: A, index: 2, part: { type: 'ui', id: 'ui_1', block: { type: 'text', text: 'x' }, toolCallId: 'tc_1' } },
      { type: 'part.added', episodeId: C, conversationId: C, turnId: T, messageId: A, index: 3, part: { type: 'tool_result', toolCallId: 'tc_1', name: 'create_reminder', output: {}, summary: 'Done' } },
      { type: 'tool.finished', episodeId: C, conversationId: C, turnId: T, messageId: A, toolCallId: 'tc_1', name: 'create_reminder', isError: false, summary: 'Done' },
      { type: 'text.delta', episodeId: C, conversationId: C, turnId: T, messageId: A, text: 'All set' },
    ]);
    expect(assistant(s).parts.map((p) => p.type)).toEqual(['text', 'tool_call', 'ui', 'tool_result', 'text']);
  });

  it('part.added never leaves holes', () => {
    expect(placePart([], 5, { type: 'text', text: 'x' })).toEqual([{ type: 'text', text: 'x' }]);
    expect(appendDelta([{ type: 'tool_call', id: 'a', name: 'n', input: {} }], 'text', 'hi')).toHaveLength(2);
  });

  it('deltas for an unknown message create a placeholder (joined mid-turn)', () => {
    const s = run([{ type: 'text.delta', episodeId: C, conversationId: C, turnId: T, messageId: 'msg_late', text: 'hi' }]);
    expect(s.messages[0]).toMatchObject({ id: 'msg_late', status: 'streaming', parts: [{ type: 'text', text: 'hi' }] });
  });

  it('message.completed replaces the message and turn.finished clears the turn', () => {
    const done: Message = { id: A, episodeId: C, conversationId: C, role: 'assistant', parts: [{ type: 'text', text: 'Final' }], createdAt: 101, status: 'complete', turnId: T };
    const s = run([
      started,
      { type: 'text.delta', episodeId: C, conversationId: C, turnId: T, messageId: A, text: 'Fin' },
      { type: 'message.completed', episodeId: C, conversationId: C, turnId: T, message: done },
      { type: 'turn.finished', episodeId: C, conversationId: C, turnId: T, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 2 } },
    ]);
    expect(assistant(s)).toMatchObject({ status: 'complete', parts: [{ type: 'text', text: 'Final' }] });
    expect(s.turn).toBeNull();
  });

  it('a cancelled turn marks a still-streaming message cancelled', () => {
    const s = run([started, { type: 'text.delta', episodeId: C, conversationId: C, turnId: T, messageId: A, text: 'Part' }, { type: 'turn.finished', episodeId: C, conversationId: C, turnId: T, stopReason: 'cancelled', usage: null }]);
    expect(assistant(s).status).toBe('cancelled');
    expect(s.turn).toBeNull();
  });

  it('turn.failed marks the message as error and records the error', () => {
    const error = { code: 'provider_error' as const, message: 'Upstream failed' };
    const s = run([started, { type: 'turn.failed', episodeId: C, conversationId: C, turnId: T, error }]);
    expect(assistant(s)).toMatchObject({ status: 'error', error });
    expect(s.turn).toBeNull();
    expect(s.lastError).toEqual(error);
  });

  const confirmation: ToolConfirmation = {
    id: 'cnf_9',
    episodeId: C, conversationId: C,
    turnId: T,
    messageId: A,
    toolCallId: 'tc_9',
    name: 'delete_note',
    title: 'Delete note',
    input: { id: 'n' },
    description: 'Delete note',
    risk: 'dangerous',
    requestedAt: 1,
    expiresAt: 2,
  };

  it('tool confirmations are added once and removed when resolved', () => {
    let s = run([started, { type: 'tool.confirmation', episodeId: C, conversationId: C, turnId: T, confirmation }, { type: 'tool.confirmation', episodeId: C, conversationId: C, turnId: T, confirmation }]);
    expect(s.confirmations).toHaveLength(1);
    s = run([{ type: 'tool.confirmation_resolved', episodeId: C, conversationId: C, turnId: T, toolCallId: 'tc_9', approved: true, reason: 'user' }], s);
    expect(s.confirmations).toHaveLength(0);
  });

  it('a resolved event carrying confirmationId removes exactly that confirmation', () => {
    const otherTurn: ToolConfirmation = { ...confirmation, id: 'cnf_10', turnId: 'turn_2', messageId: 'msg_2' };
    let s = run([started, { type: 'tool.confirmation', episodeId: C, conversationId: C, turnId: T, confirmation }, { type: 'tool.confirmation', episodeId: C, conversationId: C, turnId: 'turn_2', confirmation: otherTurn }]);
    s = run([{ type: 'tool.confirmation_resolved', episodeId: C, conversationId: C, turnId: T, confirmationId: 'cnf_10', toolCallId: 'tc_9', approved: true, reason: 'user' }], s);
    expect(s.confirmations.map((c) => c.id)).toEqual(['cnf_9']);
  });

  it('confirmations are keyed by their server id; a repeated call id in another turn is a different confirmation', () => {
    const otherTurn: ToolConfirmation = { ...confirmation, id: 'cnf_10', turnId: 'turn_2', messageId: 'msg_2' };
    let s = run([started, { type: 'tool.confirmation', episodeId: C, conversationId: C, turnId: T, confirmation }, { type: 'tool.confirmation', episodeId: C, conversationId: C, turnId: 'turn_2', confirmation: otherTurn }]);
    expect(s.confirmations.map((c) => c.id)).toEqual(['cnf_9', 'cnf_10']);
    // A newer nonce for the same call of the same turn replaces the old one.
    s = run([{ type: 'tool.confirmation', episodeId: C, conversationId: C, turnId: T, confirmation: { ...confirmation, id: 'cnf_11' } }], s);
    expect(s.confirmations.map((c) => c.id)).toEqual(['cnf_10', 'cnf_11']);
    // Resolution names the call within its turn: only that one goes.
    s = run([{ type: 'tool.confirmation_resolved', episodeId: C, conversationId: C, turnId: 'turn_2', toolCallId: 'tc_9', approved: false, reason: 'user' }], s);
    expect(s.confirmations.map((c) => c.id)).toEqual(['cnf_11']);
  });

  it('confirmations of a finished turn are dropped', () => {
    const s = run([started, { type: 'tool.confirmation', episodeId: C, conversationId: C, turnId: T, confirmation }, { type: 'turn.finished', episodeId: C, conversationId: C, turnId: T, stopReason: 'end', usage: null }]);
    expect(s.confirmations).toHaveLength(0);
  });

  it('memory.recalled is stored by turn (it arrives before turn.started)', () => {
    const items = [{ id: 'mem_1', kind: 'fact' as const, label: 'Vegetarian', score: 0.8, reason: 'matches what you said' }];
    const s = run([{ type: 'memory.recalled', episodeId: C, conversationId: C, turnId: T, items }, started]);
    expect(s.recalled[T]).toEqual(items);
  });

  it('memory.written becomes a notice; empty writes are ignored', () => {
    const created = [{ id: 'mem_2', kind: 'preference' as const, label: 'Likes tea', status: 'active' as const }];
    let s = run([{ type: 'memory.written', episodeId: C, conversationId: C, turnId: T, created, updated: [] }]);
    expect(s.notices[T]).toMatchObject({ created, updated: [] });
    const before = s;
    s = run([{ type: 'memory.written', episodeId: C, conversationId: C, turnId: 'turn_2', created: [], updated: [] }], s);
    expect(s).toBe(before);
  });

  it('episode updates and deletion retain provenance', () => {
    let s = run([{ type: 'conversation.updated', episodeId: C, conversation: episode({ lastMessageAt: 123 }) }]);
    expect(s.episodes[C]!.lastMessageAt).toBe(123);
    s = run([started], s);
    s = reduceTimeline(s, { type: 'conversation.deleted', episodeId: C, conversationId: C });
    expect(s.episodes[C]).toBeUndefined();
    expect(s.messages).toEqual([]);
  });
});

describe('cache merging', () => {
  it('mergeFetched keeps newer local messages and restores a running turn', () => {
    const streaming: Message = { id: A, episodeId: C, conversationId: C, role: 'assistant', parts: [{ type: 'text', text: 'partial' }], createdAt: 101, status: 'streaming', turnId: T };
    const merged = mergeFetched(emptyEntry(), page([userMessage, streaming], true));
    expect(merged.messages.map((m) => m.id)).toEqual(['msg_u', A]);
    expect(merged.turn).toMatchObject({ turnId: T, assistantMessageId: A });
    expect(merged.loaded).toBe(true);
    expect(merged.hasMore).toBe(true);

    const local = { ...emptyEntry(), messages: [userMessage, { ...streaming, id: 'msg_new', createdAt: 200 }] };
    const merged2 = mergeFetched(local, page([userMessage]));
    expect(merged2.messages.map((m) => m.id)).toEqual(['msg_u', 'msg_new']);
  });

  it('mergeFetched clears a turn whose message is complete', () => {
    const done: Message = { id: A, episodeId: C, conversationId: C, role: 'assistant', parts: [], createdAt: 101, status: 'complete', turnId: T };
    const entry = { ...emptyEntry(), turn: { turnId: T, assistantMessageId: A, userMessageId: null, model: null, startedAt: 1 } };
    expect(mergeFetched(entry, page([userMessage, done])).turn).toBeNull();
  });

  it('prependOlder adds older pages without duplicates', () => {
    const entry = { ...emptyEntry(), messages: [userMessage] };
    const older: Message = { ...userMessage, id: 'msg_old', createdAt: 5 };
    const next = prependOlder(entry, page([older, userMessage]));
    expect(next.messages.map((m) => m.id)).toEqual(['msg_old', 'msg_u']);
  });


});

describe('recalled memories from stored context', () => {
  const ctx = '<neo_context>\nnow: 2026-10-10 20:15 Saturday (Asia/Shanghai)\nmemories:\n- [fact] The user is vegetarian (id mem_abc123)\n- [entity] Mia, the user\'s sister (id mem_def456)\n- [bogus] nope (id mem_x)\n</neo_context>';

  it('parses memory lines', () => {
    expect(recalledFromContext(ctx)).toEqual([
      { id: 'mem_abc123', kind: 'fact', label: 'The user is vegetarian', score: 0, reason: '' },
      { id: 'mem_def456', kind: 'entity', label: "Mia, the user's sister", score: 0, reason: '' },
    ]);
  });

  it('finds them for the assistant message of the same turn', () => {
    const user: Message = { ...userMessage, parts: [{ type: 'context', text: ctx }, { type: 'text', text: 'hi' }] };
    const reply: Message = { id: A, episodeId: C, conversationId: C, role: 'assistant', parts: [], createdAt: 101, status: 'complete', turnId: T };
    expect(recalledForMessage([user, reply], reply)).toHaveLength(2);
    expect(recalledForMessage([reply], reply)).toEqual([]);
  });
});



describe('timeline ordering and deletion races', () => {
  it('preserves overlapping episode blocks and boundary message identities', () => {
    const a1 = { ...userMessage, id: 'a1', createdAt: 1 };
    const a2 = { ...userMessage, id: 'a2', createdAt: 10 };
    const b1 = { ...userMessage, id: 'b1', episodeId: 'b', conversationId: 'b', createdAt: 5 };
    const result = mergeFetched(emptyEntry(), { ...page([a1, a2, b1], true), episodes: [{ episodeId: C, startedAt: 1, offRecord: false }, { episodeId: 'b', startedAt: 5, offRecord: false }] });
    expect(result.messages.map((message) => message.id)).toEqual(['a1', 'a2', 'b1']);
    expect(result.episodes[C]?.firstMessageId).toBe('a1');
    expect(result.episodes.b?.firstMessageId).toBe('b1');
    expect(result.nextCursor).toBe('older-cursor');
  });

  it('does not invent an episode boundary when the page starts mid episode', () => {
    const result = mergeFetched(emptyEntry(), page([userMessage]));
    expect(result.episodes[C]).toBeUndefined();
  });

  it('drops stale private rows on authoritative fetch and keeps events after the request started', () => {
    const privateMessage = { ...userMessage, id: 'private', createdAt: 101 };
    const later = { ...userMessage, id: 'later', createdAt: 102 };
    const result = mergeFetched({ ...emptyEntry(), messages: [userMessage, privateMessage, later] }, page([userMessage]), new Set([userMessage.id, privateMessage.id]));
    expect(result.messages.map((message) => message.id)).toEqual([userMessage.id, 'later']);
  });

  it('cannot resurrect a deleted message or episode from a delayed completion or older page', () => {
    const startedState = run([started]);
    const removed = withoutMessages(startedState, [A]);
    const done = { ...userMessage, id: A, role: 'assistant' as const };
    expect(run([{ type: 'message.completed', episodeId: C, conversationId: C, turnId: T, message: done }], removed).messages.map((message) => message.id)).toEqual(['msg_u']);
    expect(prependOlder(removed, page([done])).messages.map((message) => message.id)).toEqual(['msg_u']);
    const purged = reduceTimeline(startedState, { type: 'conversation.deleted', episodeId: C, conversationId: C });
    expect(run([started], purged).messages).toEqual([]);
    expect(mergeFetched(purged, page([userMessage])).messages).toEqual([]);
  });

  it('ignores starts and text/part deltas replayed after a completed turn', () => {
    const done = { ...userMessage, id: A, role: 'assistant' as const };
    const completed = run([started, { type: 'message.completed', episodeId: C, conversationId: C, turnId: T, message: done }, { type: 'turn.finished', episodeId: C, conversationId: C, turnId: T, stopReason: 'end', usage: null }]);
    const replay = run([started, { type: 'text.delta', episodeId: C, conversationId: C, turnId: T, messageId: A, text: 'Duplicate' }, { type: 'part.added', episodeId: C, conversationId: C, turnId: T, messageId: A, index: 0, part: { type: 'text', text: 'Duplicate' } }], completed);
    expect(replay.messages).toEqual(completed.messages);
    expect(replay.turn).toBeNull();
  });

  it('private cleanup retains an unrelated normal running turn and legacy private metadata', () => {
    const state = run([started]);
    state.episodes.legacy = { episodeId: 'legacy', startedAt: 0, offRecord: true, ephemeral: false };
    const cleaned = reduceTimeline(state, { type: 'conversation.deleted', episodeId: 'private', conversationId: 'private' });
    expect(cleaned.turn).toBe(state.turn);
    expect(cleaned.episodes.legacy).toMatchObject({ ephemeral: false, offRecord: true });
    expect(cleaned.offRecord).toBe(false);
  });
});


it('keeps the global running turn while viewing an older around page', () => {
  const active = run([started]);
  const historical = { ...userMessage, id: 'historical', episodeId: 'old', conversationId: 'old', createdAt: 1 };
  const around = mergeFetched({ ...active, messages: [], viewAround: 'historical' }, page([historical]));
  expect(around.turn).toBe(active.turn);
  expect(mergeFetched({ ...around, viewAround: undefined }, page([historical]), new Set(around.messages.map((message) => message.id))).turn).toBeNull();
});


it('applies another device’s privacy event and removes ephemeral messages on end', () => {
  let entry = emptyEntry();
  entry.episodes.private = { episodeId: 'private', startedAt: 1, offRecord: true, ephemeral: true };
  entry.episodes.legacy = { episodeId: 'legacy', startedAt: 1, offRecord: true, ephemeral: false };
  entry = reduceTimeline(entry, { type: 'timeline.off_record', active: true });
  expect(entry).toMatchObject({ offRecord: true, offRecordLoaded: true });
  entry = reduceTimeline(entry, { type: 'timeline.off_record', active: false });
  expect(entry).toMatchObject({ offRecord: false, offRecordLoaded: true, episodes: { legacy: { ephemeral: false } }, deletedEpisodes: { private: true } });
  expect(entry.episodes.private).toBeUndefined();
});
