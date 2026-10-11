import { describe, expect, it } from 'vitest';
import type { AgentEvent, Conversation, Message, ToolConfirmation } from '@neo/protocol';
import { appendDelta, emptyEntry, mergeFetched, placePart, prependOlder, reduceConversations, sortConversations, type ConversationsData } from './conversations.js';
import { recalledForMessage, recalledFromContext } from '../lib/context.js';

const C = 'conv_1';
const T = 'turn_1';
const A = 'msg_a';

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: C,
    title: 'Chat',
    createdAt: 1,
    updatedAt: 1,
    model: null,
    incognito: false,
    pinned: false,
    archived: false,
    systemPrompt: null,
    toolset: null,
    lastMessageAt: null,
    preview: null,
    ...over,
  };
}

const userMessage: Message = { id: 'msg_u', conversationId: C, role: 'user', parts: [{ type: 'context', text: 'ctx' }, { type: 'text', text: 'Hello' }], createdAt: 100, status: 'complete', turnId: T };

function base(): ConversationsData {
  return { conversations: { [C]: conversation() }, entries: {} };
}

function run(events: AgentEvent[], state: ConversationsData = base()): ConversationsData {
  return events.reduce((s, e) => reduceConversations(s, e), state);
}

const started: AgentEvent = { type: 'turn.started', conversationId: C, turnId: T, userMessage, assistantMessageId: A, model: { provider: 'demo', model: 'neo-demo' } };

function assistant(state: ConversationsData): Message {
  return state.entries[C]!.messages.find((m) => m.id === A)!;
}

describe('reduceConversations', () => {
  it('turn.started adds the user message, a streaming placeholder and the turn', () => {
    const s = run([started]);
    const entry = s.entries[C]!;
    expect(entry.messages.map((m) => m.id)).toEqual(['msg_u', A]);
    expect(assistant(s)).toMatchObject({ role: 'assistant', status: 'streaming', parts: [], turnId: T, model: { provider: 'demo' } });
    expect(entry.turn).toMatchObject({ turnId: T, assistantMessageId: A, userMessageId: 'msg_u' });
    expect(s.conversations[C]!.preview).toBe('Hello');
    expect(s.conversations[C]!.lastMessageAt).toBe(100);
  });

  it('turn.started is idempotent (202 response + WS event)', () => {
    const s = run([started, started]);
    expect(s.entries[C]!.messages).toHaveLength(2);
  });

  it('coalesces text deltas into the last text part', () => {
    const s = run([
      started,
      { type: 'text.delta', conversationId: C, turnId: T, messageId: A, text: 'Hel' },
      { type: 'text.delta', conversationId: C, turnId: T, messageId: A, text: 'lo' },
    ]);
    expect(assistant(s).parts).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('reasoning deltas build a reasoning part completed by part.added', () => {
    const s = run([
      started,
      { type: 'reasoning.delta', conversationId: C, turnId: T, messageId: A, text: 'Let me ' },
      { type: 'reasoning.delta', conversationId: C, turnId: T, messageId: A, text: 'think' },
      { type: 'part.added', conversationId: C, turnId: T, messageId: A, index: 0, part: { type: 'reasoning', text: 'Let me think', provider: 'anthropic', data: 'sig' } },
      { type: 'text.delta', conversationId: C, turnId: T, messageId: A, text: 'Answer' },
    ]);
    expect(assistant(s).parts).toEqual([
      { type: 'reasoning', text: 'Let me think', provider: 'anthropic', data: 'sig' },
      { type: 'text', text: 'Answer' },
    ]);
  });

  it('interleaves text, tool calls, results and ui parts in order', () => {
    const s = run([
      started,
      { type: 'text.delta', conversationId: C, turnId: T, messageId: A, text: 'Sure. ' },
      { type: 'part.added', conversationId: C, turnId: T, messageId: A, index: 1, part: { type: 'tool_call', id: 'tc_1', name: 'create_reminder', input: {} } },
      { type: 'tool.started', conversationId: C, turnId: T, messageId: A, toolCallId: 'tc_1', name: 'create_reminder', title: 'Create reminder', input: {} },
      { type: 'part.added', conversationId: C, turnId: T, messageId: A, index: 2, part: { type: 'ui', id: 'ui_1', block: { type: 'text', text: 'x' }, toolCallId: 'tc_1' } },
      { type: 'part.added', conversationId: C, turnId: T, messageId: A, index: 3, part: { type: 'tool_result', toolCallId: 'tc_1', name: 'create_reminder', output: {}, summary: 'Done' } },
      { type: 'tool.finished', conversationId: C, turnId: T, messageId: A, toolCallId: 'tc_1', name: 'create_reminder', isError: false, summary: 'Done' },
      { type: 'text.delta', conversationId: C, turnId: T, messageId: A, text: 'All set' },
    ]);
    expect(assistant(s).parts.map((p) => p.type)).toEqual(['text', 'tool_call', 'ui', 'tool_result', 'text']);
  });

  it('part.added never leaves holes', () => {
    expect(placePart([], 5, { type: 'text', text: 'x' })).toEqual([{ type: 'text', text: 'x' }]);
    expect(appendDelta([{ type: 'tool_call', id: 'a', name: 'n', input: {} }], 'text', 'hi')).toHaveLength(2);
  });

  it('deltas for an unknown message create a placeholder (joined mid-turn)', () => {
    const s = run([{ type: 'text.delta', conversationId: C, turnId: T, messageId: 'msg_late', text: 'hi' }]);
    expect(s.entries[C]!.messages[0]).toMatchObject({ id: 'msg_late', status: 'streaming', parts: [{ type: 'text', text: 'hi' }] });
  });

  it('message.completed replaces the message and turn.finished clears the turn', () => {
    const done: Message = { id: A, conversationId: C, role: 'assistant', parts: [{ type: 'text', text: 'Final' }], createdAt: 101, status: 'complete', turnId: T };
    const s = run([
      started,
      { type: 'text.delta', conversationId: C, turnId: T, messageId: A, text: 'Fin' },
      { type: 'message.completed', conversationId: C, turnId: T, message: done },
      { type: 'turn.finished', conversationId: C, turnId: T, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 2 } },
    ]);
    expect(assistant(s)).toMatchObject({ status: 'complete', parts: [{ type: 'text', text: 'Final' }] });
    expect(s.entries[C]!.turn).toBeNull();
    expect(s.conversations[C]!.preview).toBe('Final');
  });

  it('a cancelled turn marks a still-streaming message cancelled', () => {
    const s = run([started, { type: 'text.delta', conversationId: C, turnId: T, messageId: A, text: 'Part' }, { type: 'turn.finished', conversationId: C, turnId: T, stopReason: 'cancelled', usage: null }]);
    expect(assistant(s).status).toBe('cancelled');
    expect(s.entries[C]!.turn).toBeNull();
  });

  it('turn.failed marks the message as error and records the error', () => {
    const error = { code: 'provider_error' as const, message: 'Upstream failed' };
    const s = run([started, { type: 'turn.failed', conversationId: C, turnId: T, error }]);
    expect(assistant(s)).toMatchObject({ status: 'error', error });
    expect(s.entries[C]!.turn).toBeNull();
    expect(s.entries[C]!.lastError).toEqual(error);
  });

  const confirmation: ToolConfirmation = {
    id: 'cnf_9',
    conversationId: C,
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
    let s = run([started, { type: 'tool.confirmation', conversationId: C, turnId: T, confirmation }, { type: 'tool.confirmation', conversationId: C, turnId: T, confirmation }]);
    expect(s.entries[C]!.confirmations).toHaveLength(1);
    s = run([{ type: 'tool.confirmation_resolved', conversationId: C, turnId: T, toolCallId: 'tc_9', approved: true, reason: 'user' }], s);
    expect(s.entries[C]!.confirmations).toHaveLength(0);
  });

  it('a resolved event carrying confirmationId removes exactly that confirmation', () => {
    const otherTurn: ToolConfirmation = { ...confirmation, id: 'cnf_10', turnId: 'turn_2', messageId: 'msg_2' };
    let s = run([started, { type: 'tool.confirmation', conversationId: C, turnId: T, confirmation }, { type: 'tool.confirmation', conversationId: C, turnId: 'turn_2', confirmation: otherTurn }]);
    s = run([{ type: 'tool.confirmation_resolved', conversationId: C, turnId: T, confirmationId: 'cnf_10', toolCallId: 'tc_9', approved: true, reason: 'user' }], s);
    expect(s.entries[C]!.confirmations.map((c) => c.id)).toEqual(['cnf_9']);
  });

  it('confirmations are keyed by their server id; a repeated call id in another turn is a different confirmation', () => {
    const otherTurn: ToolConfirmation = { ...confirmation, id: 'cnf_10', turnId: 'turn_2', messageId: 'msg_2' };
    let s = run([started, { type: 'tool.confirmation', conversationId: C, turnId: T, confirmation }, { type: 'tool.confirmation', conversationId: C, turnId: 'turn_2', confirmation: otherTurn }]);
    expect(s.entries[C]!.confirmations.map((c) => c.id)).toEqual(['cnf_9', 'cnf_10']);
    // A newer nonce for the same call of the same turn replaces the old one.
    s = run([{ type: 'tool.confirmation', conversationId: C, turnId: T, confirmation: { ...confirmation, id: 'cnf_11' } }], s);
    expect(s.entries[C]!.confirmations.map((c) => c.id)).toEqual(['cnf_10', 'cnf_11']);
    // Resolution names the call within its turn: only that one goes.
    s = run([{ type: 'tool.confirmation_resolved', conversationId: C, turnId: 'turn_2', toolCallId: 'tc_9', approved: false, reason: 'user' }], s);
    expect(s.entries[C]!.confirmations.map((c) => c.id)).toEqual(['cnf_11']);
  });

  it('confirmations of a finished turn are dropped', () => {
    const s = run([started, { type: 'tool.confirmation', conversationId: C, turnId: T, confirmation }, { type: 'turn.finished', conversationId: C, turnId: T, stopReason: 'end', usage: null }]);
    expect(s.entries[C]!.confirmations).toHaveLength(0);
  });

  it('memory.recalled is stored by turn (it arrives before turn.started)', () => {
    const items = [{ id: 'mem_1', kind: 'fact' as const, label: 'Vegetarian', score: 0.8, reason: 'matches what you said' }];
    const s = run([{ type: 'memory.recalled', conversationId: C, turnId: T, items }, started]);
    expect(s.entries[C]!.recalled[T]).toEqual(items);
  });

  it('memory.written becomes a notice; empty writes are ignored', () => {
    const pending = [{ id: 'mem_2', kind: 'preference' as const, label: 'Likes tea', status: 'pending' as const }];
    let s = run([{ type: 'memory.written', conversationId: C, turnId: T, created: [], updated: [], pending }]);
    expect(s.entries[C]!.notices[T]).toMatchObject({ pending, resolved: {} });
    const before = s;
    s = run([{ type: 'memory.written', conversationId: C, turnId: 'turn_2', created: [], updated: [], pending: [] }], s);
    expect(s).toBe(before);
  });

  it('conversation.updated and conversation.deleted maintain the list', () => {
    let s = run([{ type: 'conversation.updated', conversation: conversation({ title: 'Kyoto trip', pinned: true }) }]);
    expect(s.conversations[C]!.title).toBe('Kyoto trip');
    s = run([started], s);
    s = reduceConversations(s, { type: 'conversation.deleted', conversationId: C });
    expect(s.conversations[C]).toBeUndefined();
    expect(s.entries[C]).toBeUndefined();
  });
});

describe('cache merging', () => {
  it('mergeFetched keeps newer local messages and restores a running turn', () => {
    const streaming: Message = { id: A, conversationId: C, role: 'assistant', parts: [{ type: 'text', text: 'partial' }], createdAt: 101, status: 'streaming', turnId: T };
    const merged = mergeFetched(emptyEntry(), { conversation: conversation(), messages: [streaming, userMessage], hasMore: true });
    expect(merged.messages.map((m) => m.id)).toEqual(['msg_u', A]);
    expect(merged.turn).toMatchObject({ turnId: T, assistantMessageId: A });
    expect(merged.loaded).toBe(true);
    expect(merged.hasMore).toBe(true);

    const local = { ...emptyEntry(), messages: [userMessage, { ...streaming, id: 'msg_new', createdAt: 200 }] };
    const merged2 = mergeFetched(local, { conversation: conversation(), messages: [userMessage], hasMore: false });
    expect(merged2.messages.map((m) => m.id)).toEqual(['msg_u', 'msg_new']);
  });

  it('mergeFetched clears a turn whose message is complete', () => {
    const done: Message = { id: A, conversationId: C, role: 'assistant', parts: [], createdAt: 101, status: 'complete', turnId: T };
    const entry = { ...emptyEntry(), turn: { turnId: T, assistantMessageId: A, userMessageId: null, model: null, startedAt: 1 } };
    expect(mergeFetched(entry, { conversation: conversation(), messages: [userMessage, done], hasMore: false }).turn).toBeNull();
  });

  it('prependOlder adds older pages without duplicates', () => {
    const entry = { ...emptyEntry(), messages: [userMessage] };
    const older: Message = { ...userMessage, id: 'msg_old', createdAt: 5 };
    const next = prependOlder(entry, { conversation: conversation(), messages: [older, userMessage], hasMore: false });
    expect(next.messages.map((m) => m.id)).toEqual(['msg_old', 'msg_u']);
  });

  it('sorts pinned first, then by activity', () => {
    const a = conversation({ id: 'a', lastMessageAt: 10 });
    const b = conversation({ id: 'b', lastMessageAt: 20 });
    const p = conversation({ id: 'p', lastMessageAt: 1, pinned: true });
    expect(sortConversations([a, b, p]).map((c) => c.id)).toEqual(['p', 'b', 'a']);
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
    const reply: Message = { id: A, conversationId: C, role: 'assistant', parts: [], createdAt: 101, status: 'complete', turnId: T };
    expect(recalledForMessage([user, reply], reply)).toHaveLength(2);
    expect(recalledForMessage([reply], reply)).toEqual([]);
  });
});

