import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortable, fetchTransport, isBlockedAddress, readCapped, vetUrl } from './net.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

describe('abortable listener balance', () => {
  it.each([undefined, null, 'done'])('removes its listener after resolving with %s', async value => {
    const abort = trackedAbortController();
    await expect(abortable(Promise.resolve(value), abort.signal)).resolves.toBe(value);
    expect(abort.remaining).toBe(0);
  });

  it('removes its listener after rejection', async () => {
    const abort = trackedAbortController();
    const error = new Error('failed');
    await expect(abortable(Promise.reject(error), abort.signal)).rejects.toBe(error);
    expect(abort.remaining).toBe(0);
  });

  it('leaves no listener for an already aborted signal', async () => {
    const abort = trackedAbortController();
    abort.controller.abort();
    await expect(abortable(Promise.resolve(), abort.signal)).rejects.toBe(abort.signal.reason);
    expect(abort.remaining).toBe(0);
  });

  it.each(['pending', 'resolve', 'reject'] as const)('leaves no listener after abort and late promise settlement (%s)', async outcome => {
    const abort = trackedAbortController();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const underlying = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const result = abortable(underlying, abort.signal);
    expect(abort.remaining).toBe(1);
    const reason = new Error('cancelled');
    const rejected = expect(result).rejects.toBe(reason);
    abort.controller.abort(reason);
    await rejected;
    expect(abort.remaining).toBe(0);
    if (outcome === 'resolve') resolve();
    if (outcome === 'reject') reject(new Error('late failure'));
    if (outcome !== 'pending') await underlying.catch(() => {});
    expect(abort.remaining).toBe(0);
  });

  it('leaves no listener when a timeout aborts the operation', async () => {
    vi.useFakeTimers();
    const abort = trackedAbortController();
    const reason = new DOMException('Timed out', 'TimeoutError');
    const result = abortable(new Promise<never>(() => {}), abort.signal);
    const rejected = expect(result).rejects.toBe(reason);
    setTimeout(() => abort.controller.abort(reason), 10);
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(abort.remaining).toBe(0);
  });
});

describe('net operations listener balance', () => {
  it.each(['literal', 'private allowed', 'invalid', 'resolver throws'] as const)('leaves no listener without a DNS await on %s', async outcome => {
    const abort = trackedAbortController();
    const resolver = vi.fn(() => { throw new Error('DNS failed'); });
    const result = vetUrl(outcome === 'invalid' ? 'file:///test' : outcome === 'literal' ? 'https://93.184.216.34' : 'https://example.test', {
      resolver, signal: abort.signal, allowPrivateNetwork: outcome === 'private allowed', isBlockedAddress,
    });
    if (outcome === 'invalid' || outcome === 'resolver throws') await expect(result).rejects.toThrow();
    else await expect(result).resolves.toHaveProperty('url');
    expect(resolver).toHaveBeenCalledTimes(outcome === 'resolver throws' ? 1 : 0);
    expect(abort.remaining).toBe(0);
  });

  it.each(['public', 'empty', 'blocked', 'reject'] as const)('balances the DNS await for a %s result', async outcome => {
    const abort = trackedAbortController();
    const result = vetUrl('https://example.test', {
      resolver: async () => {
        if (outcome === 'reject') throw new Error('DNS failed');
        return outcome === 'empty' ? [] : [outcome === 'blocked' ? '127.0.0.1' : '93.184.216.34'];
      },
      signal: abort.signal, allowPrivateNetwork: false, isBlockedAddress,
    });
    if (outcome === 'public') await expect(result).resolves.toHaveProperty('addresses', ['93.184.216.34']);
    else await expect(result).rejects.toThrow();
    expect(abort.remaining).toBe(0);
  });

  it('removes the DNS listener on cancellation while the resolver stays pending', async () => {
    const abort = trackedAbortController();
    const result = vetUrl('https://example.test', {
      resolver: () => new Promise(() => {}),
      signal: abort.signal, allowPrivateNetwork: false, isBlockedAddress,
    });
    const reason = new Error('cancelled');
    expect(abort.remaining).toBe(1);
    const rejected = expect(result).rejects.toBe(reason);
    abort.controller.abort(reason);
    await rejected;
    expect(abort.remaining).toBe(0);
  });

  const target = { url: new URL('https://example.test'), addresses: [] };
  const enc = new TextEncoder();

  it.each(['body', 'empty', 'bodyless', 'early', 'close', 'error'] as const)('balances fetch and body reads on %s completion', async outcome => {
    const abort = trackedAbortController();
    const stream = outcome === 'bodyless' ? null : new ReadableStream<Uint8Array>({ start(controller) {
      if (outcome === 'error') controller.error(new Error('read failed'));
      else {
        if (outcome !== 'empty') controller.enqueue(enc.encode('text'));
        if (outcome !== 'early') controller.close();
      }
    } });
    const transport = fetchTransport(vi.fn(async () => new Response(stream)) as typeof fetch);
    const response = await transport(target, { signal: abort.signal, headers: {} });
    expect(abort.remaining).toBe(0);
    if (outcome === 'close') response.close();
    else {
      const result = readCapped(response.body, outcome === 'early' ? 1 : 100);
      if (outcome === 'error') await expect(result).rejects.toThrow('read failed');
      else await expect(result).resolves.toHaveProperty('truncated', outcome === 'early');
    }
    expect(abort.remaining).toBe(0);
  });

  it('balances a fetch rejection', async () => {
    const abort = trackedAbortController();
    const transport = fetchTransport(vi.fn(async () => { throw new Error('fetch failed'); }) as typeof fetch);
    await expect(transport(target, { signal: abort.signal, headers: {} })).rejects.toThrow('fetch failed');
    expect(abort.remaining).toBe(0);
  });

  it('leaves no listener when fetch throws synchronously', async () => {
    const abort = trackedAbortController();
    const transport = fetchTransport(vi.fn(() => { throw new Error('fetch failed'); }) as typeof fetch);
    await expect(transport(target, { signal: abort.signal, headers: {} })).rejects.toThrow('fetch failed');
    expect(abort.remaining).toBe(0);
  });

  it('removes the fetch listener on cancellation while fetch stays pending', async () => {
    const abort = trackedAbortController();
    const transport = fetchTransport(vi.fn(() => new Promise<Response>(() => {})) as typeof fetch);
    const result = transport(target, { signal: abort.signal, headers: {} });
    const reason = new Error('cancelled');
    expect(abort.remaining).toBe(1);
    const rejected = expect(result).rejects.toBe(reason);
    abort.controller.abort(reason);
    await rejected;
    expect(abort.remaining).toBe(0);
  });

  it.each(['abort', 'close'] as const)('balances a pending body read when stopped by %s', async outcome => {
    const abort = trackedAbortController();
    const cancelled = vi.fn();
    const transport = fetchTransport(vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }))) as typeof fetch);
    const response = await transport(target, { signal: abort.signal, headers: {} });
    const result = readCapped(response.body, 100);
    expect(abort.remaining).toBe(1);
    if (outcome === 'abort') {
      const reason = new Error('cancelled');
      const rejected = expect(result).rejects.toBe(reason);
      abort.controller.abort(reason);
      await rejected;
    } else {
      response.close();
      await expect(result).resolves.toHaveProperty('bytes', new Uint8Array());
    }
    expect(cancelled).toHaveBeenCalledOnce();
    expect(abort.remaining).toBe(0);
  });
});
