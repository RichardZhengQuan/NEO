import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@neo/protocol';
import { readEventStream } from './sse.js';

describe('readEventStream', () => {
  it('aborts between buffered events', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"a"}\n\ndata: {"type":"b"}\n\n'));
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
