import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@neo/protocol';
import { readEventStream } from './sse.js';

const event = (text: string): AgentEvent => ({
  type: 'text.delta', conversationId: 'c1', episodeId: 'c1', turnId: 't1', messageId: 'm1', text,
});

async function collectChunks(chunks: Uint8Array[]): Promise<AgentEvent[]> {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }));
  const events: AgentEvent[] = [];
  for await (const item of readEventStream(response)) events.push(item);
  expect(response.body!.locked).toBe(false);
  return events;
}

describe('readEventStream', () => {
  it('dispatches a complete CR-only frame before reading again from an open stream', async () => {
    const expected = event('live CR frame');
    let pulls = 0;
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(expected)}\r\r`));
        } else {
          controller.error(new Error('Read another chunk before dispatching a complete CR frame'));
        }
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    const iterator = readEventStream(response)[Symbol.asyncIterator]();

    try {
      await expect(iterator.next()).resolves.toEqual({ value: expected, done: false });
      expect(pulls).toBe(1);
    } finally {
      await iterator.return?.();
    }
    expect(cancelled).toBe(true);
    expect(response.body!.locked).toBe(false);
  });

  it.each(['\r', '\n', '\r\n'])('parses comments and multiline data with %j line endings', async (ending) => {
    const expected = event('multiline');
    const lines = [': heartbeat', 'event: ignored', 'id: ignored', 'retry: 1000',
      ...JSON.stringify(expected, null, 2).split('\n').map((line) => `data: ${line}`), '', ''];
    const wire = lines.join(ending);
    expect(await collectChunks([new TextEncoder().encode(wire)])).toEqual([expected]);
  });

  it('handles mixed endings and byte-wise UTF-8 chunks without duplicating events', async () => {
    const first = event('你好 café 🎉');
    const second = event('second');
    const wire = `: heartbeat\rdata: ${JSON.stringify(first)}\r\rdata: ${JSON.stringify(second)}\r\n\r\n`;
    const chunks = [...new TextEncoder().encode(wire)].map((byte) => Uint8Array.of(byte));
    expect(await collectChunks(chunks)).toEqual([first, second]);
  });

  it('consumes LF after a CR at chunk boundaries without extra or missing dispatches', async () => {
    const first = event('first');
    const second = event('second');
    const chunks = [`data: ${JSON.stringify(first)}\r`, '\n\r', '\n',
      `data: ${JSON.stringify(second)}\r`, '\n\r', '\n'].map((text) => new TextEncoder().encode(text));
    expect(await collectChunks(chunks)).toEqual([first, second]);
  });

  it.each(['', '\r', '\n', '\r\n'])('discards an event without its final blank line at EOF (%j)', async (ending) => {
    const wire = `data: ${JSON.stringify(event('unfinished'))}${ending}`;
    expect(await collectChunks([new TextEncoder().encode(wire)])).toEqual([]);
  });

  it('keeps a completed CR frame but discards the following unfinished event at EOF', async () => {
    const complete = event('complete');
    const wire = `data: ${JSON.stringify(complete)}\r\rdata: ${JSON.stringify(event('unfinished'))}\r`;
    expect(await collectChunks([new TextEncoder().encode(wire)])).toEqual([complete]);
  });

  it.each(['\r', '\n', '\r\n'])('aborts between buffered events with %j line endings', async (ending) => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: {"type":"a"}${ending}${ending}data: {"type":"b"}${ending}${ending}`));
        controller.close();
      },
    }));
    const controller = new AbortController();
    const events: AgentEvent[] = [];

    for await (const event of readEventStream(response, controller.signal)) {
      events.push(event);
      controller.abort();
    }

    expect(events).toEqual([{ type: 'a' }]);
    expect(response.body!.locked).toBe(false);
  });

  it('breaking the iterator cancels the reader', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"a"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    }));
    const events: AgentEvent[] = [];

    for await (const event of readEventStream(response)) {
      events.push(event);
      break;
    }

    expect(events).toEqual([{ type: 'a' }]);
    expect(response.body!.locked).toBe(false);
    expect(cancelled).toBe(true);
  });

  it('releases the reader for a pre-aborted signal', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }));
    const controller = new AbortController();
    controller.abort();
    const events: AgentEvent[] = [];

    for await (const event of readEventStream(response, controller.signal)) {
      events.push(event);
    }

    expect(events).toEqual([]);
    expect(response.body!.locked).toBe(false);
    expect(cancelled).toBe(true);
  });

  it('releases the reader at EOF', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"a"}\n\n'));
        controller.close();
      },
    }));
    const events: AgentEvent[] = [];

    for await (const event of readEventStream(response)) {
      events.push(event);
    }

    expect(events).toEqual([{ type: 'a' }]);
    expect(response.body!.locked).toBe(false);
  });

  it('releases the reader after a read error', async () => {
    const failure = new TypeError('network drop');
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    }));
    const iterator = readEventStream(response)[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      name: 'NeoError',
      code: 'stream_read_failed',
      cause: failure,
    });
    expect(response.body!.locked).toBe(false);
  });

  it.each(['return', 'throw'] as const)('releases the reader when the consumer exits with %s', async (exit) => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"a"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    }));
    const failure = new Error('consumer failure');
    const events: AgentEvent[] = [];
    const consumed = (async () => {
      for await (const event of readEventStream(response)) {
        events.push(event);
        if (exit === 'throw') throw failure;
        return;
      }
    })();

    if (exit === 'throw') {
      await expect(consumed).rejects.toBe(failure);
    } else {
      await consumed;
    }
    expect(events).toEqual([{ type: 'a' }]);
    expect(response.body!.locked).toBe(false);
    expect(cancelled).toBe(true);
  });
});
