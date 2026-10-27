import { afterEach, expect, it, vi } from 'vitest';
import { NeoError } from '@neo/protocol';
import { parseSSE } from './index.js';
import { byteStream } from './testing/http.js';

afterEach(() => { vi.restoreAllMocks(); });

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

it('parseSSE wraps a mid-stream read error as NeoError(stream_read_failed)', async () => {
  const failure = new TypeError('network drop');
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      controller.enqueue(new TextEncoder().encode('data: first\n\n'));
    },
  });
  const messages: { data: string }[] = [];
  const abort = trackedAbortController();
  const result = (async () => {
    for await (const message of parseSSE(body, abort.signal)) {
      messages.push(message);
      controller.error(failure);
    }
  })();

  await expect(result).rejects.toBeInstanceOf(NeoError);
  await expect(result).rejects.toMatchObject({
    code: 'stream_read_failed',
    message: 'The response body failed mid-stream.',
    retryable: true,
    status: 500,
  });
  await result.catch((err) => expect(err.cause).toBe(failure));
  expect(messages).toEqual([{ data: 'first' }]);
  expect(abort.remaining).toBe(0);
  expect(body.locked).toBe(false);
});

it('parseSSE abort path still yields NeoError(cancelled)', async () => {
  const abort = trackedAbortController();
  const iterator = parseSSE(byteStream(['data: first\n\n'], { hang: true }), abort.signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({ data: 'first' });

  const pending = iterator.next();
  abort.controller.abort();

  await expect(pending).rejects.toBeInstanceOf(NeoError);
  await expect(pending).rejects.toMatchObject({ code: 'cancelled', retryable: false });
  expect(abort.remaining).toBe(0);
});

it('parseSSE: generator unwinds after abort even when reader.cancel() never resolves', async () => {
  // A stream whose cancel() returns a never-resolving promise.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      // Stream stays open; a subsequent reader.read() call hangs.
    },
    cancel(): Promise<void> {
      return new Promise<void>(() => {}); // never resolves
    },
  });

  const abort = trackedAbortController();
  const iterator = parseSSE(body, abort.signal)[Symbol.asyncIterator]();

  // Consume the first buffered event.
  expect((await iterator.next()).value).toEqual({ data: 'first' });

  // Kick off the next read (hangs: stream is open, no more data).
  const pending = iterator.next();

  // Abort while reader.read() is pending.
  abort.controller.abort();

  // The hanging .next() must reject promptly with NeoError('cancelled') even
  // though reader.cancel() will never resolve.
  await expect(pending).rejects.toBeInstanceOf(NeoError);
  await expect(pending).rejects.toMatchObject({ code: 'cancelled', retryable: false });
  expect(abort.remaining).toBe(0);

  // The generator must be fully wound down — .return() resolves with done: true.
  const returnResult = await iterator.return!(undefined);
  expect(returnResult.done).toBe(true);
  expect(abort.remaining).toBe(0);
  expect(body.locked).toBe(false);
});

it('parseSSE: generator unwinds after a later abort while consumer return waits on reader.cancel()', async () => {
  let onCancelStarted!: () => void;
  const cancelStarted = new Promise<void>((resolve) => {
    onCancelStarted = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      // Stay open so consumer return enters finally before the stream is done.
    },
    cancel(): Promise<void> {
      onCancelStarted();
      return new Promise<void>(() => {});
    },
  });

  const abort = trackedAbortController();
  const iterator = parseSSE(body, abort.signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({ data: 'first' });

  const returnPromise = iterator.return!(undefined);
  // Abort only after finally has started waiting on the never-resolving cancel.
  await cancelStarted;
  abort.controller.abort();

  await expect(returnPromise).resolves.toMatchObject({ done: true });
  expect(abort.remaining).toBe(0);
  expect(body.locked).toBe(false);
});

it.each(['empty', 'complete event', 'final event'] as const)('parseSSE leaves no listener after %s EOF', async (exit) => {
  const abort = trackedAbortController();
  const chunks = exit === 'empty' ? [] : [exit === 'complete event' ? 'data: first\n\n' : 'data: first'];
  const body = byteStream(chunks);
  const messages = [];
  for await (const message of parseSSE(body, abort.signal)) messages.push(message);
  expect(messages).toEqual(exit === 'empty' ? [] : [{ data: 'first' }]);
  expect(abort.remaining).toBe(0);
  expect(body.locked).toBe(false);
  abort.controller.abort();
  expect(abort.remaining).toBe(0);
});

it.each(['resolve', 'reject'] as const)('parseSSE leaves no listener after early return when cancellation will %s', async (exit) => {
  const abort = trackedAbortController();
  const cancel = vi.fn(() => exit === 'reject' ? Promise.reject(new Error('Cancel failed')) : Promise.resolve());
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\ndata: second\n\n')); },
    cancel,
  });
  for await (const message of parseSSE(body, abort.signal)) {
    expect(message).toEqual({ data: 'first' });
    break;
  }
  expect(cancel).toHaveBeenCalledOnce();
  expect(abort.remaining).toBe(0);
  expect(body.locked).toBe(false);
  abort.controller.abort();
  expect(abort.remaining).toBe(0);
});

it('parseSSE registers no listener when already aborted or when reader acquisition fails', async () => {
  const abort = trackedAbortController();
  abort.controller.abort();
  const cancel = vi.fn();
  await expect(parseSSE(new ReadableStream<Uint8Array>({ cancel }), abort.signal)[Symbol.asyncIterator]().next())
    .rejects.toMatchObject({ code: 'cancelled' });
  expect(cancel).toHaveBeenCalledOnce();
  expect(abort.remaining).toBe(0);

  const live = trackedAbortController();
  const body = byteStream([]);
  const reader = body.getReader();
  await expect(parseSSE(body, live.signal)[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(TypeError);
  expect(live.remaining).toBe(0);
  reader.releaseLock();
});
