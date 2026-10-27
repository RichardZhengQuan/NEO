import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatModel, ChatStreamEvent } from '@neo/protocol';
import { MEMORY_CONSTANTS } from './constants.js';
import { buildExtractionInput, callModel, llmExtract } from './extract.js';

function trackedAbortController() {
  const controller = new AbortController();
  const signal = controller.signal;
  type Listener = NonNullable<Parameters<AbortSignal['addEventListener']>[1]>;
  type Registration = { listener: Listener; capture: boolean; wrapper: (event: Event) => void };
  const listeners = new Set<Registration>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  vi.spyOn(signal, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type !== 'abort' || !listener) return add(type, listener, options);
    const capture = typeof options === 'boolean' ? options : options?.capture ?? false;
    if ([...listeners].some(entry => entry.listener === listener && entry.capture === capture)) return;
    const once = typeof options === 'object' && options.once;
    const entry: Registration = { listener, capture, wrapper(event) {
      // Native once-listeners are removed before their callback is invoked.
      if (once) listeners.delete(entry);
      if (typeof listener === 'function') listener.call(signal, event);
      else listener.handleEvent(event);
    } };
    listeners.add(entry);
    add(type, entry.wrapper, options);
  });
  vi.spyOn(signal, 'removeEventListener').mockImplementation((type, listener, options) => {
    const capture = typeof options === 'boolean' ? options : options?.capture ?? false;
    const entry = type === 'abort' && [...listeners].find(item => item.listener === listener && item.capture === capture);
    if (!entry) return remove(type, listener, options);
    listeners.delete(entry);
    remove(type, entry.wrapper, options);
  });
  return { controller, signal, get remaining() { return listeners.size; } };
}

describe('callModel abort listener balance', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(['complete', 'empty', 'chat error', 'stream error', 'caller abort', 'timeout', 'internal cancellation'] as const)('retains no caller listener after %s', async (exit) => {
    vi.useFakeTimers();
    const abort = trackedAbortController();
    const { controller, signal } = abort;
    const error = exit === 'internal cancellation' ? new DOMException('Model cancelled', 'AbortError') : new Error('Model failed');
    let started!: () => void;
    const streaming = new Promise<void>(resolve => { started = resolve; });
    const llm: ChatModel = {
      chat(request) {
        expect(abort.remaining).toBe(1);
        if (exit === 'chat error') throw error;
        return (async function* (): AsyncIterable<ChatStreamEvent> {
          if (exit === 'stream error' || exit === 'internal cancellation') throw error;
          if (exit === 'caller abort' || exit === 'timeout') {
            await new Promise<never>((_, reject) => {
              request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
              started();
            });
          }
          if (exit === 'complete') yield { type: 'text', text: 'reply' };
        })();
      },
    };

    const call = callModel(llm, { model: 'fake', system: '', user: '', maxTokens: 1, purpose: 'test', signal });
    const result = exit === 'timeout'
      ? expect(call).rejects.toThrow(`memory model call timed out after ${MEMORY_CONSTANTS.llmTimeoutMs} ms`)
      : exit === 'complete' || exit === 'empty'
        ? expect(call).resolves.toBe(exit === 'complete' ? 'reply' : '')
        : expect(call).rejects.toBe(error);
    if (exit === 'caller abort' || exit === 'timeout') {
      await streaming;
      if (exit === 'caller abort') controller.abort(error);
      else await vi.advanceTimersByTimeAsync(MEMORY_CONSTANTS.llmTimeoutMs);
    }
    await result;
    expect(abort.remaining).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    expect(abort.remaining).toBe(0);
  });
});

describe('extractMemories validUntil guard', () => {
  it.each([
    { name: 'drops out-of-range validUntil 1e20', json: '1e20', expected: undefined },
    { name: 'drops negative validUntil -1', json: '-1', expected: undefined },
    { name: 'drops zero validUntil', json: '0', expected: undefined },
    // A valid JSON number that parses as Infinity, rather than stringifying to null.
    { name: 'drops infinite validUntil', json: '1e309', expected: undefined },
    { name: 'preserves in-range numeric validUntil', json: '1765000000000', expected: 1_765_000_000_000 },
    { name: 'parses ISO string validUntil', json: '"2026-11-01T00:00:00Z"', expected: Date.parse('2026-11-01T00:00:00Z') },
  ])('$name', async ({ json, expected }) => {
    const llm: ChatModel = {
      async *chat(): AsyncIterable<ChatStreamEvent> {
        yield {
          type: 'text',
          text: `{"memories":[{"op":"create","kind":"fact","label":"Visiting Paris","content":"The user is visiting Paris.","validUntil":${json}}]}`,
        };
        yield { type: 'done', stopReason: 'end' };
      },
    };
    const input = buildExtractionInput({
      userText: 'I am visiting Paris for a while.',
      assistantText: 'I will remember that.',
      related: [],
      policy: { allowedKinds: ['fact'] },
      allowSensitive: true,
      date: '2026-10-22',
    });

    const result = await llmExtract(llm, 'fake', input);

    expect(result?.memories).toHaveLength(1);
    const op = result!.memories[0]!;
    expect(op.op).toBe('create');
    if (op.op !== 'create') throw new Error('Expected the create operation to survive extraction');
    expect(op.validUntil).toBe(expected);
  });
});
