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
