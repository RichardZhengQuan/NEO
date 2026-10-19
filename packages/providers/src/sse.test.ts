import { expect, it } from 'vitest';
import { NeoError } from '@neo/protocol';
import { parseSSE } from './index.js';
import { byteStream } from './testing/http.js';

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
  const result = (async () => {
    for await (const message of parseSSE(body)) {
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
});

it('parseSSE abort path still yields NeoError(cancelled)', async () => {
  const ac = new AbortController();
  const iterator = parseSSE(byteStream(['data: first\n\n'], { hang: true }), ac.signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({ data: 'first' });

  const pending = iterator.next();
  ac.abort();

  await expect(pending).rejects.toBeInstanceOf(NeoError);
  await expect(pending).rejects.toMatchObject({ code: 'cancelled', retryable: false });
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

  const ac = new AbortController();
  const iterator = parseSSE(body, ac.signal)[Symbol.asyncIterator]();

  // Consume the first buffered event.
  expect((await iterator.next()).value).toEqual({ data: 'first' });

  // Kick off the next read (hangs: stream is open, no more data).
  const pending = iterator.next();

  // Abort while reader.read() is pending.
  ac.abort();

  // The hanging .next() must reject promptly with NeoError('cancelled') even
  // though reader.cancel() will never resolve.
  await expect(pending).rejects.toBeInstanceOf(NeoError);
  await expect(pending).rejects.toMatchObject({ code: 'cancelled', retryable: false });

  // The generator must be fully wound down — .return() resolves with done: true.
  const returnResult = await iterator.return!(undefined);
  expect(returnResult.done).toBe(true);
});
