/**
 * Cancellation helper unit tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortable, cancelledError, raceAbort } from './abort.js';
import { NeoError } from '@neo/protocol';

afterEach(() => vi.restoreAllMocks());

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

describe('abort listener tracker', () => {
  it('drops a once-listener before invoking it', () => {
    const tracked = trackedAbortController();
    const listener = vi.fn(() => expect(tracked.remaining).toBe(0));
    tracked.signal.addEventListener('abort', listener, { once: true });
    expect(tracked.remaining).toBe(1);
    tracked.controller.abort();
    expect(listener).toHaveBeenCalledOnce();
    expect(tracked.remaining).toBe(0);
  });

  it('maps explicit removal to the original function and ignores a different function', () => {
    const tracked = trackedAbortController();
    const listener = vi.fn();
    tracked.signal.addEventListener('abort', listener, { once: true });
    tracked.signal.removeEventListener('abort', () => {});
    expect(tracked.remaining).toBe(1);
    tracked.signal.removeEventListener('abort', listener);
    expect(tracked.remaining).toBe(0);
    tracked.controller.abort();
    expect(listener).not.toHaveBeenCalled();
  });

  it('preserves an object listener receiver', () => {
    const tracked = trackedAbortController();
    const listener = { handleEvent: vi.fn(function (this: object) { expect(this).toBe(listener); }) };
    tracked.signal.addEventListener('abort', listener, { once: true });
    tracked.controller.abort();
    expect(listener.handleEvent).toHaveBeenCalledOnce();
    expect(tracked.remaining).toBe(0);
  });
});

describe('raceAbort', () => {
  it('resolves with the promise value when signal is not aborted', async () => {
    const controller = new AbortController();
    const result = await raceAbort(Promise.resolve(42), controller.signal);
    expect(result).toBe(42);
  });

  it('rejects immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(raceAbort(Promise.resolve(42), controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('rejects with cancelled when signal fires mid-flight', async () => {
    const controller = new AbortController();
    let resolve!: (v: number) => void;
    const pending = new Promise<number>((r) => { resolve = r; });
    const race = raceAbort(pending, controller.signal);
    controller.abort();
    await expect(race).rejects.toMatchObject({ code: 'cancelled' });
    // Resolving the now-loser promise must not cause an unhandled rejection.
    resolve(1);
    await Promise.resolve();
  });

  it.each(['value', 'empty', 'error'] as const)('balances its listener after promise %s completion', async (outcome) => {
    const tracked = trackedAbortController();
    const error = new Error('source failed');
    const promise = outcome === 'error' ? Promise.reject(error) : Promise.resolve(outcome === 'empty' ? undefined : 42);
    const result = raceAbort(promise, tracked.signal);
    expect(tracked.remaining).toBe(1);
    if (outcome === 'error') await expect(result).rejects.toBe(error);
    else await expect(result).resolves.toBe(outcome === 'empty' ? undefined : 42);
    expect(tracked.remaining).toBe(0);
    tracked.controller.abort();
    expect(tracked.remaining).toBe(0);
  });

  it('retains no listener for an already-aborted signal', async () => {
    const tracked = trackedAbortController();
    tracked.controller.abort();
    await expect(raceAbort(Promise.resolve(42), tracked.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(tracked.remaining).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)('retains no listener after abort and late %s', async (outcome) => {
    const tracked = trackedAbortController();
    let resolve!: (value: number) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<number>((res, rej) => { resolve = res; reject = rej; });
    const result = raceAbort(pending, tracked.signal);
    expect(tracked.remaining).toBe(1);
    tracked.controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    expect(tracked.remaining).toBe(0);
    if (outcome === 'resolve') resolve(42);
    else reject(new Error('late failure'));
    await pending.catch(() => {});
    expect(tracked.remaining).toBe(0);
  });
});

describe('cancelledError', () => {
  it('returns a NeoError with code cancelled', () => {
    const err = cancelledError();
    expect(err).toBeInstanceOf(NeoError);
    expect(err.code).toBe('cancelled');
  });
});

describe('abortable', () => {
  it.each(['end', 'empty', 'error', 'break'] as const)('balances pull listeners on %s', async (outcome) => {
    const tracked = trackedAbortController();
    const error = new Error('source failed');
    async function* source() {
      if (outcome === 'error') throw error;
      if (outcome !== 'empty') yield 1;
    }
    const consume = async () => {
      for await (const _ of abortable(source(), tracked.signal)) {
        expect(tracked.remaining).toBe(0);
        if (outcome === 'break') break;
      }
    };
    if (outcome === 'error') await expect(consume()).rejects.toBe(error);
    else await consume();
    expect(tracked.remaining).toBe(0);
  });

  it('detaches a pending pull on abort even when the source never settles', async () => {
    const tracked = trackedAbortController();
    let closed!: () => void;
    const closing = new Promise<void>(resolve => { closed = resolve; });
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<number>>(() => {}),
          async return() { closed(); return { done: true as const, value: undefined }; },
        };
      },
    };
    const next = abortable(source, tracked.signal).next();
    expect(tracked.remaining).toBe(1);
    tracked.controller.abort();
    await expect(next).rejects.toMatchObject({ code: 'cancelled' });
    await closing;
    expect(tracked.remaining).toBe(0);
  });

  it('yields all values from a finite iterable when not aborted', async () => {
    const controller = new AbortController();
    async function* source() {
      yield 1;
      yield 2;
      yield 3;
    }
    const values: number[] = [];
    for await (const v of abortable(source(), controller.signal)) {
      values.push(v);
    }
    expect(values).toEqual([1, 2, 3]);
  });

  it('throws cancelled without calling next() when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    let pulls = 0;
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            pulls++;
            // Simulate slow provider work after the pull is counted.
            await new Promise<void>((r) => setTimeout(r, 10));
            return { value: pulls, done: false as const };
          },
          async return() {
            return { value: undefined, done: true as const };
          },
        };
      },
    };

    await expect(async () => {
      for await (const _ of abortable(source, controller.signal)) {
        // should never enter
      }
    }).rejects.toMatchObject({ code: 'cancelled' });

    // The critical invariant: the loop must not have dispatched a pull.
    expect(pulls).toBe(0);
  });

  it('stops iterating and throws cancelled when signal fires mid-stream', async () => {
    const controller = new AbortController();
    const values: number[] = [];

    async function* source() {
      yield 1;
      // Abort during the second iteration.
      controller.abort();
      yield 2;
    }

    await expect(async () => {
      for await (const v of abortable(source(), controller.signal)) {
        values.push(v);
      }
    }).rejects.toMatchObject({ code: 'cancelled' });

    // First value arrived before abort; second was blocked.
    expect(values).toEqual([1]);
  });
});
