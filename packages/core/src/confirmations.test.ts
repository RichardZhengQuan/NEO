import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmationManager } from './confirmations.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

const confirmation = {
  id: 'cnf_1', conversationId: 'conv_1', episodeId: 'conv_1', turnId: 'turn_1', messageId: 'msg_1',
  toolCallId: 'call_1', name: 't', title: 'T', input: {}, description: 'T', risk: 'write' as const,
  requestedAt: 0, expiresAt: 1,
};

describe('ConfirmationManager listener balance', () => {
  it.each(['approve', 'deny', 'timeout', 'abort', 'cancelTurn', 'cancelTool', 'cancelAll'] as const)(
    'retains no listener after %s', async (outcome) => {
      vi.useFakeTimers();
      const tracked = trackedAbortController();
      const manager = new ConfirmationManager();
      const pending = manager.waitForDecision(confirmation, 1000, tracked.signal);
      expect(tracked.remaining).toBe(1);
      if (outcome === 'approve' || outcome === 'deny') manager.resolve(confirmation.id, { approve: outcome === 'approve' });
      else if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(1000);
      else if (outcome === 'abort') tracked.controller.abort();
      else if (outcome === 'cancelTurn') manager.cancelTurn(confirmation.turnId);
      else if (outcome === 'cancelTool') manager.cancelTool(confirmation.name);
      else manager.cancelAll();
      await expect(pending).resolves.toEqual({ approve: outcome === 'approve',
        reason: outcome === 'approve' || outcome === 'deny' ? 'user' : outcome === 'timeout' ? 'timeout' : 'cancelled' });
      expect(tracked.remaining).toBe(0);
      expect(manager.list()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      manager.resolve(confirmation.id, { approve: true });
      manager.cancelAll();
      tracked.controller.abort();
      await vi.runAllTimersAsync();
      expect(tracked.remaining).toBe(0);
    },
  );

  it('retains no listener or pending confirmation for an already-aborted signal', async () => {
    vi.useFakeTimers();
    const tracked = trackedAbortController();
    const manager = new ConfirmationManager();
    tracked.controller.abort();
    await expect(manager.waitForDecision(confirmation, 1000, tracked.signal)).resolves.toEqual({ approve: false, reason: 'cancelled' });
    expect(tracked.remaining).toBe(0);
    expect(manager.list()).toEqual([]);
    expect(manager.hasToolCall(confirmation.toolCallId)).toBe(false);
    expect(manager.resolve(confirmation.id, { approve: true })).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains no listener when rejecting a duplicate id', async () => {
    vi.useFakeTimers();
    const tracked = trackedAbortController();
    const duplicate = trackedAbortController();
    const manager = new ConfirmationManager();
    const pending = manager.waitForDecision(confirmation, 1000, tracked.signal);
    await expect(manager.waitForDecision(confirmation, 1000, duplicate.signal)).rejects.toMatchObject({ code: 'conflict' });
    expect(duplicate.remaining).toBe(0);
    expect(tracked.remaining).toBe(1);
    manager.cancelAll();
    await pending;
    expect(tracked.remaining).toBe(0);
  });
});
