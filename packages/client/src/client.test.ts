/**
 * Tests for NeoClient, NeoApiError, readEventStream, and connect().
 *
 * Covers:
 * - HTTP method/path/query/body/headers for each route group
 * - Error mapping: JSON ErrorShape, non-JSON 502, network failure, timeout
 * - SSE parsing across chunk boundaries
 * - WebSocket auth handshake, event delivery, subscribe, reconnect with backoff,
 *   no reconnect after close() or 4401
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NeoClient, NeoApiError, readEventStream, type ListResponse, type TimelineSearchHit, type TimelineSearchSnippet, type ToolUseEvent, type Task } from './index.js';
import { apiRequest } from './http.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fake fetch helpers
// ─────────────────────────────────────────────────────────────────────────────

interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface FakeResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function makeFetch(responses: FakeResponse[]) {
  let idx = 0;
  const requests: FakeRequest[] = [];

  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req: FakeRequest = {
      method: init?.method ?? 'GET',
      url: typeof input === 'string' ? input : input.toString(),
      headers: {},
      body: undefined,
    };

    // Extract headers.
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) {
        req.headers[k.toLowerCase()] = v;
      }
    }

    // Extract body.
    if (init?.body && typeof init.body === 'string') {
      try {
        req.body = JSON.parse(init.body);
      } catch {
        req.body = init.body;
      }
    }

    requests.push(req);

    const resp = responses[idx++] ?? { status: 200, body: {} };

    // Build Headers object.
    const respHeaders: Record<string, string> = { 'content-type': 'application/json', ...resp.headers };
    const headers = new Headers(respHeaders);

    if (resp.status === 204) {
      return new Response(null, { status: 204, headers });
    }

    const bodyStr = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
    return new Response(bodyStr, { status: resp.status, headers });
  };

  return { fetchFn, requests };
}

function makeClient(responses: FakeResponse[]) {
  const { fetchFn, requests } = makeFetch(responses);
  const client = new NeoClient({
    baseUrl: 'http://localhost:7777',
    token: 'test-token',
    fetch: fetchFn as typeof fetch,
  });
  return { client, requests };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers & query encoding
// ─────────────────────────────────────────────────────────────────────────────

describe('buildQuery', () => {
  it('encodes arrays as comma-separated values', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [], total: 0 } }]);
    await client.memory.search({ kinds: ['fact', 'preference'], limit: 10 });
    const req = requests[0]!;
    expect(req.url).toContain('kinds=fact%2Cpreference');
    expect(req.url).toContain('limit=10');
  });

  it('encodes booleans as true/false', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [], total: 0 } }]);
    await client.notifications.list({ unread: false });
    const req = requests[0]!;
    expect(req.url).toContain('unread=false');
  });

  it('skips undefined values', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.notes.list({ query: undefined });
    expect(requests[0]!.url).not.toContain('query=');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth header
// ─────────────────────────────────────────────────────────────────────────────

describe('Authorization header', () => {
  it('sends Bearer token', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { ok: true, name: 'neo', version: '0.1.0', apiVersion: '1', mode: 'local', onboarded: true, time: 0 } }]);
    await client.health();
    expect(requests[0]!.headers['authorization']).toBe('Bearer test-token');
  });

  it('setToken updates subsequent requests', async () => {
    const { client, requests } = makeClient([
      { status: 200, body: { items: [] } },
      { status: 200, body: { items: [] } },
    ]);
    await client.notifications.list();
    client.setToken('new-token');
    await client.notifications.list();
    expect(requests[0]!.headers['authorization']).toBe('Bearer test-token');
    expect(requests[1]!.headers['authorization']).toBe('Bearer new-token');
  });

  it('omits Authorization when token is undefined', async () => {
    const { fetchFn, requests } = makeFetch([{ status: 200, body: { ok: true, name: 'neo', version: '0.1.0', apiVersion: '1', mode: 'local', onboarded: true, time: 0 } }]);
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', fetch: fetchFn as typeof fetch });
    await client.health();
    expect(requests[0]!.headers['authorization']).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('NeoApiError mapping', () => {
  it('parses a JSON ErrorShape body', async () => {
    const { client } = makeClient([{
      status: 404,
      body: { code: 'not_found', message: 'Conversation not found', retryable: false },
    }]);
    const err = await client.timeline.list({ around: 'bad-id' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.code).toBe('not_found');
    expect(apiErr.message).toBe('Conversation not found');
    expect(apiErr.httpStatus).toBe(404);
  });

  it('falls back to internal for non-JSON 502', async () => {
    const { fetchFn } = makeFetch([]);
    let idx = 0;
    const fetchWith502 = async (): Promise<Response> => {
      idx++;
      return new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    };
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: fetchWith502 as typeof fetch });
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.code).toBe('internal');
    expect(apiErr.httpStatus).toBe(502);
  });

  it('maps network failure to internal retryable', async () => {
    const failFetch = async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    };
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: failFetch as typeof fetch });
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.code).toBe('internal');
    expect(apiErr.retryable).toBe(true);
  });

  it('maps timeout to timeout code', async () => {
    const timeoutFetch = async (_: unknown, init?: RequestInit): Promise<Response> => {
      // Simulate timeout by throwing a TimeoutError.
      const err = new DOMException('Timeout', 'TimeoutError');
      throw err;
    };
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: timeoutFetch as typeof fetch, timeoutMs: 1 });
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.code).toBe('timeout');
  });

  it('maps body-stall timeout to timeout code', async () => {
    vi.useFakeTimers();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stallingFetch = async (_: unknown, init?: RequestInit): Promise<Response> => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          // Body left open — never closes on its own.
        },
      });
      // When the signal fires, cancel the stream so the body read rejects.
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          streamController.error(signal.reason);
        }, { once: true });
      }
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const client = new NeoClient({
      baseUrl: 'http://localhost:7777',
      token: 'tok',
      fetch: stallingFetch as typeof fetch,
      timeoutMs: 10,
    });

    let outcome: 'pending' | 'resolved' | NeoApiError = 'pending';
    client.health().then(
      () => { outcome = 'resolved'; },
      (e: unknown) => { outcome = e as NeoApiError; },
    );

    // Headers arrived; body is stalled. Timer has NOT fired yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe('pending');

    // Advance past the 10 ms deadline.
    await vi.advanceTimersByTimeAsync(11);

    expect(outcome).toBeInstanceOf(NeoApiError);
    const apiErr = outcome as unknown as NeoApiError;
    expect(apiErr.code).toBe('timeout');
    expect(apiErr.httpStatus).toBe(504);
    expect(apiErr.retryable).toBe(true);

    // Tear-down: close the stream to prevent dangling handles.
    try { streamController.close(); } catch { /* already errored */ }
    vi.useRealTimers();
  });

  it('maps error-body stall timeout to timeout code', async () => {
    vi.useFakeTimers();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    try {
      const stallingFetch = async (_: unknown, init?: RequestInit): Promise<Response> => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(new TextEncoder().encode('{"code":'));
          },
        });
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          streamController?.error(signal.reason);
        }, { once: true });
        return new Response(stream, { status: 503 });
      };
      const client = new NeoClient({
        baseUrl: 'http://localhost:7777',
        token: 'tok',
        fetch: stallingFetch as typeof fetch,
        timeoutMs: 10,
      });
      let outcome: unknown = 'pending';
      const result = client.health().then(
        (value) => { outcome = value; },
        (err: unknown) => { outcome = err; },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(11);

      expect(outcome).toBeInstanceOf(NeoApiError);
      expect(outcome).toMatchObject({
        code: 'timeout',
        message: 'Request timed out.',
        httpStatus: 504,
        retryable: true,
      });
      await result;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      streamController?.error(new DOMException('Cleanup', 'AbortError'));
      vi.useRealTimers();
    }
  });

  it.each([200, 503])('preserves caller AbortError during a %i body read', async (status) => {
    vi.useFakeTimers();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    try {
      const stallingFetch = async (_: unknown, init?: RequestInit): Promise<Response> => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(new TextEncoder().encode('{"ok":'));
          },
        });
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          streamController?.error(signal.reason);
        }, { once: true });
        return new Response(stream, { status });
      };
      const controller = new AbortController();
      const result = apiRequest({
        baseUrl: 'http://localhost:7777',
        token: 'tok',
        fetch: stallingFetch as typeof fetch,
        timeoutMs: 10,
      }, { path: '/health', signal: controller.signal }).catch((err: unknown) => err);

      // Deliver headers and start the body read before the caller aborts.
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      const err = await result;

      expect(err).toBe(controller.signal.reason);
      expect(err).toMatchObject({ name: 'AbortError' });
      expect(err).not.toBeInstanceOf(NeoApiError);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      streamController?.error(new DOMException('Cleanup', 'AbortError'));
      vi.useRealTimers();
    }
  });

  it('preserves a pre-classified NeoApiError thrown by fetch in the request path', async () => {
    const injected = new NeoApiError(403, { code: 'forbidden', message: 'Owner only', details: { reason: 'owner_only' }, retryable: false });
    const throwFetch = async (): Promise<Response> => { throw injected; };
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: throwFetch as typeof fetch });
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBe(injected);
    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.httpStatus).toBe(403);
    expect(apiErr.code).toBe('forbidden');
    expect(apiErr.retryable).toBe(false);
  });

  it('preserves a pre-classified NeoApiError thrown by fetch in the stream path', async () => {
    const injected = new NeoApiError(403, { code: 'forbidden', message: 'Owner only', details: { reason: 'owner_only' }, retryable: false });
    const throwFetch = async (): Promise<Response> => { throw injected; };
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: throwFetch as typeof fetch });
    const err = await (async () => {
      for await (const _ of client.timeline.stream({ text: 'hello' })) { /* drain */ }
    })().catch((e: unknown) => e);
    expect(err).toBe(injected);
    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.httpStatus).toBe(403);
    expect(apiErr.code).toBe('forbidden');
    expect(apiErr.retryable).toBe(false);
  });

  it('propagates AbortError from stream error-body read instead of wrapping as HTTP 503', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const abortCtrl = new AbortController();
    const stallingFetch = async (_: unknown, init?: RequestInit): Promise<Response> => {
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          streamController = ctrl;
          // Partial JSON — stalls response.json().
          ctrl.enqueue(new TextEncoder().encode('{"code":'));
        },
      });
      const sig = (init as RequestInit | undefined)?.signal;
      sig?.addEventListener('abort', () => { streamController?.error(sig.reason); }, { once: true });
      return new Response(stream, { status: 503 });
    };
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: stallingFetch as typeof fetch });
    const resultP = (async () => {
      for await (const _ of client.timeline.stream({ text: 'hi' }, abortCtrl.signal)) { /* drain */ }
    })().catch((e: unknown) => e);
    // Yield so the fetch resolves and response.json() starts reading.
    await Promise.resolve();
    abortCtrl.abort();
    const err = await resultP;
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(err).not.toBeInstanceOf(NeoApiError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route groups
// ─────────────────────────────────────────────────────────────────────────────

describe('timeline routes', () => {
  it('lists pages with opaque cursors and jump targets', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [], episodes: [], nextCursor: null } }]);
    await client.timeline.list({ limit: 20, before: 'opaque:cursor' });
    await client.timeline.list({ limit: 20, around: 'message-1' });
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.url).toContain('/api/timeline?');
    expect(requests[0]!.url).toContain('before=opaque%3Acursor');
    expect(requests[1]!.url).toContain('around=message-1');
    expect(requests[1]!.url).not.toContain('before=');
    expect(requests[0]!.url).toContain('limit=20');
    expect(client).not.toHaveProperty('conversations');
  });

  it('preserves sensitivity metadata and episode ids', async () => {
    const message = {
      id: 'private_msg', conversationId: 'episode-1', episodeId: 'episode-1', role: 'assistant', status: 'complete', createdAt: 1, sensitive: true,
      parts: [{ type: 'tool_result', toolCallId: 'recall_call', name: 'recall', output: { memories: [] }, sensitive: true }],
    };
    const { client } = makeClient([{ status: 200, body: { items: [message], episodes: [], nextCursor: null } }]);
    expect((await client.timeline.list()).items[0]).toEqual(message);
  });

  it('sends without a conversation id and carries off-record mode', async () => {
    const response = { episodeId: 'episode-1', turnId: 't1', assistantMessageId: 'm1', userMessage: {} };
    const { client, requests } = makeClient([{ status: 202, body: response }]);
    expect(await client.timeline.send({ text: 'hello', offRecord: true })).toEqual(response);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/timeline/messages');
    expect(requests[0]!.body).toEqual({ text: 'hello', offRecord: true });
  });

  it('cancels and executes UI actions in the timeline', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { cancelled: true } }, { status: 200, body: { kind: 'noop' } }]);
    await client.timeline.cancel('turn-1');
    await client.timeline.uiAction({ messageId: 'm1', uiId: 'u1', actionId: 'a1' });
    expect(requests[0]!.url).toContain('/api/timeline/cancel');
    expect(requests[0]!.body).toEqual({ turnId: 'turn-1' });
    expect(requests[1]!.url).toContain('/api/timeline/ui-action');
  });

  it('reads and starts the authoritative off-record state', async () => {
    const inactive = { active: false, episodeId: null, startedAt: null };
    const active = { active: true, episodeId: 'private-ep', startedAt: 42 };
    const { client, requests } = makeClient([{ status: 200, body: inactive }, { status: 200, body: active }]);
    expect(await client.timeline.offRecord()).toEqual(inactive);
    expect(await client.timeline.startOffRecord()).toEqual(active);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.url).toContain('/api/timeline/off-record');
    expect(requests[1]!.method).toBe('POST');
    expect(requests[1]!.url).toContain('/api/timeline/off-record/start');
    expect(requests[1]!.body).toEqual({});
  });

  it('returns typed search text and highlight ranges without changing literal brackets', async () => {
    const snippet: TimelineSearchSnippet = {
      text: 'I prefer window seats, with literal [brackets].',
      highlights: [[9, 15], [16, 21]],
    };
    const response: ListResponse<TimelineSearchHit> = {
      items: [{ messageId: 'msg-1', episodeId: 'ep-1', createdAt: 42, snippet }],
    };
    const { client, requests } = makeClient([{ status: 200, body: response }]);
    const result: ListResponse<TimelineSearchHit> = await client.timeline.search('window seats', 12);
    expect(result).toEqual(response);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.url).toContain('/api/timeline/search?q=window+seats&limit=12');
  });

  it('searches, deletes messages and ranges, ends off-record, and forgets sources', async () => {
    const { client, requests } = makeClient([]);
    await client.timeline.search('blue sky', 12);
    await client.timeline.deleteMessage('msg/1');
    await client.timeline.deleteRange({ from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' });
    await client.timeline.endOffRecord();
    await client.memory.forgetBySource(['msg_1', 'msg_2']);
    expect(requests[0]!.url).toContain('/api/timeline/search?q=blue+sky&limit=12');
    expect(requests[1]!.url).toContain('/api/timeline/messages/msg%2F1');
    expect(requests[1]!.method).toBe('DELETE');
    expect(requests[2]!.url).toContain('/api/timeline?from=2026-10-01T00%3A00%3A00Z');
    expect(requests[2]!.method).toBe('DELETE');
    expect(requests[3]!.url).toContain('/api/timeline/off-record/end');
    expect(requests[4]!.url).toContain('/api/memory/forget-by-source');
    expect(requests[4]!.body).toEqual({ messageIds: ['msg_1', 'msg_2'] });
  });

  it('streams timeline events with episode ids', async () => {
    const event = { type: 'text.delta', episodeId: 'ep', conversationId: 'ep', turnId: 't', messageId: 'm', text: 'hello' };
    const { client, requests } = makeClient([{ status: 200, body: `event: text.delta\ndata: ${JSON.stringify(event)}\n\n`, headers: { 'content-type': 'text/event-stream' } }]);
    const events = [];
    for await (const item of client.timeline.stream({ text: 'hello' })) events.push(item);
    expect(events).toEqual([event]);
    expect(requests[0]!.url).toContain('/api/timeline/messages');
    expect(requests[0]!.headers.accept).toBe('text/event-stream');
  });
});

describe('timeline.stream', () => {
  it('cancels response body when content-type is not text/event-stream', async () => {
    const cancelFn = vi.fn().mockResolvedValue(undefined);
    const stream = new ReadableStream({ start(c) { c.close(); } });
    Object.defineProperty(stream, 'cancel', { value: cancelFn, writable: true });

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: fetchFn as typeof fetch });
    let err: unknown;
    try {
      for await (const _ of client.timeline.stream({ text: 'hi' })) { /* drain */ }
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NeoApiError);
    expect((err as NeoApiError).code).toBe('bad_upstream');
    expect(cancelFn).toHaveBeenCalledOnce();
  });

  it('throws bad_upstream when response content-type is text/html', async () => {
    const { fetchFn, requests } = makeFetch([{
      status: 200,
      body: '<html>Frontend fallback</html>',
      headers: { 'content-type': 'text/html' },
    }]);
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: fetchFn as typeof fetch });
    const events = [];
    let err: unknown;
    try {
      for await (const item of client.timeline.stream({ text: 'hi' })) events.push(item);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.code).toBe('bad_upstream');
    expect(apiErr.message).toBe('Expected text/event-stream, got text/html');
    expect(apiErr.httpStatus).toBe(502);
    expect(apiErr.retryable).toBe(true);
    expect(events).toEqual([]);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/timeline/messages');
    expect(requests[0]!.body).toEqual({ text: 'hi' });
  });

  it('accepts mixed-case text/event-stream', async () => {
    const event = { type: 'text.delta', episodeId: 'ep', conversationId: 'ep', turnId: 't', messageId: 'm', text: 'hi' };
    const { fetchFn } = makeFetch([{
      status: 200,
      body: `event: text.delta\ndata: ${JSON.stringify(event)}\n\n`,
      headers: { 'content-type': 'Text/Event-Stream' },
    }]);
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: fetchFn as typeof fetch });
    const events = [];
    for await (const item of client.timeline.stream({ text: 'hi' })) events.push(item);
    expect(events).toEqual([event]);
  });

  it('accepts text/event-stream with charset parameter', async () => {
    const event = { type: 'text.delta', episodeId: 'ep', conversationId: 'ep', turnId: 't', messageId: 'm', text: 'hi' };
    const { fetchFn } = makeFetch([{
      status: 200,
      body: `event: text.delta\ndata: ${JSON.stringify(event)}\n\n`,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }]);
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: fetchFn as typeof fetch });
    const events = [];
    for await (const item of client.timeline.stream({ text: 'hi' })) events.push(item);
    expect(events).toEqual([event]);
  });

  it('throws bad_upstream on prefix lookalike text/event-streaming', async () => {
    const { fetchFn } = makeFetch([{
      status: 200,
      body: '<html>Not SSE</html>',
      headers: { 'content-type': 'text/event-streaming' },
    }]);
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: fetchFn as typeof fetch });
    const events = [];
    let err: unknown;
    try {
      for await (const item of client.timeline.stream({ text: 'hi' })) events.push(item);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.code).toBe('bad_upstream');
    expect(apiErr.message).toBe('Expected text/event-stream, got text/event-streaming');
    expect(events).toEqual([]);
  });

  it('throws bad_upstream on prefix lookalike text/event-stream+json', async () => {
    const { fetchFn } = makeFetch([{
      status: 200,
      body: '{"not":"sse"}',
      headers: { 'content-type': 'text/event-stream+json' },
    }]);
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', token: 'tok', fetch: fetchFn as typeof fetch });
    let err: unknown;
    try {
      for await (const _ of client.timeline.stream({ text: 'hi' })) { /* drain */ }
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NeoApiError);
    expect((err as NeoApiError).code).toBe('bad_upstream');
  });
});

describe('confirmations routes', () => {
  it('list: GET /api/confirmations', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.confirmations.list();
    expect(requests[0]!.url).toContain('/api/confirmations');
  });

  it('respond: POST /api/confirmations/:id', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { ok: true } }]);
    await client.confirmations.respond('tc-1', { approve: true });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/confirmations/tc-1');
    expect((requests[0]!.body as { approve: boolean }).approve).toBe(true);
  });
});

describe('memory routes', () => {
  it('toolUses: reads typed tool-use events within an epoch-millisecond range', async () => {
    const event: ToolUseEvent = {
      id: 'msg_1:call_1', at: 1791504000000, tool: 'create_note', category: 'note',
      title: 'Wrote note “Kyoto itinerary”', messageId: 'msg_1', target: { kind: 'note', id: 'note_1' },
    };
    const { client, requests } = makeClient([{ status: 200, body: { items: [event] } }]);
    const response = await client.memory.toolUses({ from: 0, to: 1791590400000, limit: 500 });
    expect(response.items).toEqual([event]);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.url).toBe('http://localhost:7777/api/memory/tool-uses?from=0&to=1791590400000&limit=500');
    expect(requests[0]!.body).toBeUndefined();
    expect(requests[0]!.headers['authorization']).toBe('Bearer test-token');
  });

  it('toolUses: omits unspecified range bounds', async () => {
    const { client, requests } = makeClient([
      { status: 200, body: { items: [] } },
      { status: 200, body: { items: [] } },
    ]);
    await client.memory.toolUses();
    await client.memory.toolUses({ from: undefined, to: 100 });
    expect(requests[0]!.url).toBe('http://localhost:7777/api/memory/tool-uses');
    expect(requests[1]!.url).toBe('http://localhost:7777/api/memory/tool-uses?to=100');
  });

  it('search: GET /api/memory with comma-separated kinds', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [], total: 0 } }]);
    await client.memory.search({ kinds: ['fact', 'preference'], limit: 5 });
    expect(requests[0]!.url).toContain('/api/memory');
    expect(requests[0]!.url).toContain('kinds=fact%2Cpreference');
    expect(requests[0]!.url).toContain('limit=5');
  });

  it('get: GET /api/memory/:id', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { id: 'm1' } }]);
    await client.memory.get('m1');
    expect(requests[0]!.url).toContain('/api/memory/m1');
  });

  it('create: POST /api/memory', async () => {
    const { client, requests } = makeClient([{ status: 201, body: { id: 'm1' } }]);
    await client.memory.create({ content: 'I like cats', kind: 'preference' });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toMatch(/\/api\/memory$/);
  });

  it('forget: POST /api/memory/forget', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { deleted: 2 } }]);
    await client.memory.forget(['m1', 'm2']);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/memory/forget');
    expect((requests[0]!.body as { ids: string[] }).ids).toEqual(['m1', 'm2']);
  });

  it('link: POST /api/memory/links', async () => {
    const { client, requests } = makeClient([{ status: 201, body: {} }]);
    await client.memory.link({ from: 'a', to: 'b', type: 'related' });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/memory/links');
  });

  it('unlink: DELETE /api/memory/links/:id', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { ok: true } }]);
    await client.memory.unlink('edge-1');
    expect(requests[0]!.method).toBe('DELETE');
    expect(requests[0]!.url).toContain('/api/memory/links/edge-1');
  });

  it('export: GET /api/memory/export?embeddings=1', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { nodes: [], edges: [], exportedAt: 0 } }]);
    await client.memory.export(true);
    expect(requests[0]!.url).toContain('embeddings=1');
  });

  it('stats: GET /api/memory/stats', async () => {
    const { client, requests } = makeClient([{ status: 200, body: {} }]);
    await client.memory.stats();
    expect(requests[0]!.url).toContain('/api/memory/stats');
  });

  it('consolidate: POST /api/memory/consolidate', async () => {
    const { client, requests } = makeClient([{ status: 200, body: {} }]);
    await client.memory.consolidate();
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/memory/consolidate');
  });

  it('journal: GET /api/memory/journal', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.memory.journal(5);
    expect(requests[0]!.url).toContain('/api/memory/journal');
    expect(requests[0]!.url).toContain('limit=5');
  });
});

describe('reminders routes', () => {
  it('list: GET /api/reminders', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.reminders.list({ status: ['scheduled', 'fired'], limit: 10 });
    expect(requests[0]!.url).toContain('/api/reminders');
    expect(requests[0]!.url).toContain('status=scheduled%2Cfired');
  });

  it('create: POST /api/reminders', async () => {
    const { client, requests } = makeClient([{ status: 201, body: { id: 'r1' } }]);
    await client.reminders.create({ title: 'Call mom', dueAt: Date.now() + 60000 });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/reminders');
  });

  it('snooze: POST /api/reminders/:id/snooze', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { id: 'r1' } }]);
    await client.reminders.snooze('r1', 15);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/reminders/r1/snooze');
    expect((requests[0]!.body as { minutes: number }).minutes).toBe(15);
  });

  it('complete: POST /api/reminders/:id/complete', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { id: 'r1' } }]);
    await client.reminders.complete('r1');
    expect(requests[0]!.url).toContain('/api/reminders/r1/complete');
  });
});

describe('tasks routes', () => {
  it('lists: GET /api/task-lists', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.tasks.lists();
    expect(requests[0]!.url).toContain('/api/task-lists');
  });

  it('createList: POST /api/task-lists', async () => {
    const { client, requests } = makeClient([{ status: 201, body: { id: 'tl1' } }]);
    await client.tasks.createList({ name: 'Work' });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/task-lists');
  });

  it('deleteList: DELETE /api/task-lists/:id → 204', async () => {
    const { client, requests } = makeClient([{ status: 204, body: null }]);
    await client.tasks.deleteList('tl1');
    expect(requests[0]!.method).toBe('DELETE');
    expect(requests[0]!.url).toContain('/api/task-lists/tl1');
  });

  it('list: GET /api/tasks', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.tasks.list({ done: false, query: 'groceries' });
    expect(requests[0]!.url).toContain('/api/tasks');
    expect(requests[0]!.url).toContain('done=false');
    expect(requests[0]!.url).toContain('query=groceries');
  });

  it('get: returns the typed task using an encoded ID and a single read-only request', async () => {
    const task: Task = {
      id: 'task/with?reserved#characters', listId: 'list_inbox', title: 'Prepare proposal', notes: null,
      done: true, doneAt: 100, dueAt: 200, priority: 3, tags: ['work'], order: 0, parentId: null,
      createdAt: 50, updatedAt: 100,
    };
    const { client, requests } = makeClient([{ status: 200, body: task }]);
    const result: Task = await client.tasks.get(task.id);
    expect(result).toEqual(task);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.url).toBe('http://localhost:7777/api/tasks/task%2Fwith%3Freserved%23characters');
    expect(requests[0]!.body).toBeUndefined();
    expect(requests[0]!.headers['authorization']).toBe('Bearer test-token');
  });

  it('get: preserves the missing-task error without attempting a mutation', async () => {
    const { client, requests } = makeClient([{ status: 404, body: { code: 'not_found', message: 'Task not found', retryable: false } }]);
    await expect(client.tasks.get('missing')).rejects.toMatchObject({
      name: 'NeoApiError', code: 'not_found', httpStatus: 404, retryable: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.body).toBeUndefined();
  });

  it('create: POST /api/tasks', async () => {
    const { client, requests } = makeClient([{ status: 201, body: { id: 'task1' } }]);
    await client.tasks.create({ title: 'Buy milk', listId: 'tl1' });
    expect(requests[0]!.method).toBe('POST');
  });

  it('delete: DELETE /api/tasks/:id → 204', async () => {
    const { client, requests } = makeClient([{ status: 204, body: null }]);
    await client.tasks.delete('task1');
    expect(requests[0]!.method).toBe('DELETE');
  });
});

describe('notes routes', () => {
  it('list: GET /api/notes', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.notes.list({ tag: 'work' });
    expect(requests[0]!.url).toContain('/api/notes');
    expect(requests[0]!.url).toContain('tag=work');
  });

  it('get: GET /api/notes/:id', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { id: 'n1' } }]);
    await client.notes.get('n1');
    expect(requests[0]!.url).toContain('/api/notes/n1');
  });

  it('delete: DELETE /api/notes/:id → 204', async () => {
    const { client, requests } = makeClient([{ status: 204, body: null }]);
    await client.notes.delete('n1');
    expect(requests[0]!.method).toBe('DELETE');
  });
});

describe('notifications routes', () => {
  it('list: GET /api/notifications', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.notifications.list({ unread: true, limit: 50 });
    expect(requests[0]!.url).toContain('/api/notifications');
    expect(requests[0]!.url).toContain('unread=true');
  });

  it('markRead: POST /api/notifications/read', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { count: 3 } }]);
    await client.notifications.markRead(['n1', 'n2', 'n3']);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/notifications/read');
  });
});

describe('OpenRouter authentication routes', () => {
  it('starts OAuth through the authenticated server', async () => {
    const response = { url: 'https://openrouter.ai/auth?state=test-state', state: 'test-state', expiresAt: 123_000 };
    const { client, requests } = makeClient([{ status: 200, body: response }]);
    expect(await client.auth.openrouterStart()).toEqual(response);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('http://localhost:7777/api/auth/openrouter/start');
    expect(requests[0]!.headers['authorization']).toBe('Bearer test-token');
  });

  it('cancels the matching server-side pending authorization', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { cancelled: true } }]);
    expect(await client.auth.openrouterCancel('test-state')).toEqual({ cancelled: true });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('http://localhost:7777/api/auth/openrouter/cancel');
    expect(requests[0]!.body).toEqual({ state: 'test-state' });
  });
});

describe('ChatGPT authentication routes', () => {
  it('starts sign-in or reauthorizes a saved provider without credentials in the request', async () => {
    const response = { url: 'https://auth.openai.com/api/accounts/authorize?state=test-state', state: 'test-state', expiresAt: 123_000 };
    const { client, requests } = makeClient([{ status: 200, body: response }, { status: 200, body: response }]);
    expect(await client.auth.chatgptStart()).toEqual(response);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('http://localhost:7777/api/auth/chatgpt/start');
    expect(requests[0]!.headers['authorization']).toBe('Bearer test-token');
    expect(requests[0]!.body).toEqual({});
    await client.auth.chatgptStart('chatgpt');
    expect(requests[1]!.body).toEqual({ providerId: 'chatgpt' });
  });

  it('cancels an attempt and reads safe status using its opaque state', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { cancelled: true } }, { status: 200, body: { status: 'waiting' } }]);
    expect(await client.auth.chatgptCancel('test-state')).toEqual({ cancelled: true });
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('http://localhost:7777/api/auth/chatgpt/cancel');
    expect(requests[0]!.body).toEqual({ state: 'test-state' });
    expect(await client.auth.chatgptStatus('test state')).toEqual({ status: 'waiting' });
    expect(requests[1]!.method).toBe('GET');
    expect(requests[1]!.url).toBe('http://localhost:7777/api/auth/chatgpt/status?state=test+state');
  });
});

describe('providers routes', () => {
  it('list: GET /api/providers', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [], defaultModel: null } }]);
    await client.providers.list();
    expect(requests[0]!.url).toContain('/api/providers');
  });

  it('create: POST /api/providers', async () => {
    const { client, requests } = makeClient([{ status: 201, body: { id: 'openai' } }]);
    await client.providers.create({ kind: 'openai', apiKey: 'sk-xxx', enabled: true });
    expect(requests[0]!.method).toBe('POST');
  });

  it('test: POST /api/providers/:id/test', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { ok: true } }]);
    await client.providers.test('openai');
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/providers/openai/test');
  });

  it('testDraft: POST /api/providers/test', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { ok: true } }]);
    await client.providers.testDraft({ kind: 'openai', apiKey: 'sk-xxx' });
    expect(requests[0]!.url).toContain('/api/providers/test');
    expect((requests[0]!.body as { kind: string }).kind).toBe('openai');
  });
});

describe('settings routes', () => {
  it('get: GET /api/settings', async () => {
    const { client, requests } = makeClient([{ status: 200, body: {} }]);
    await client.settings.get();
    expect(requests[0]!.url).toContain('/api/settings');
  });

  it('update: PATCH /api/settings', async () => {
    const { client, requests } = makeClient([{ status: 200, body: {} }]);
    await client.settings.update({ userName: 'Alice' } as never);
    expect(requests[0]!.method).toBe('PATCH');
  });
});

describe('tools routes', () => {
  it('list: GET /api/tools', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.tools.list();
    expect(requests[0]!.url).toContain('/api/tools');
  });

  it('setPermission: PUT /api/tools/:name/permission', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { name: 'web_fetch' } }]);
    await client.tools.setPermission('web_fetch', 'auto');
    expect(requests[0]!.method).toBe('PUT');
    expect(requests[0]!.url).toContain('/api/tools/web_fetch/permission');
    expect((requests[0]!.body as { permission: string }).permission).toBe('auto');
  });
});

describe('devices routes', () => {
  it('list: GET /api/devices', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { items: [] } }]);
    await client.devices.list();
    expect(requests[0]!.url).toContain('/api/devices');
  });

  it('create: POST /api/devices', async () => {
    const { client, requests } = makeClient([{ status: 201, body: { device: {}, token: 'tok', pairingUrl: 'neo://...' } }]);
    await client.devices.create('My Phone', 'ios');
    expect(requests[0]!.method).toBe('POST');
    expect((requests[0]!.body as { name: string; platform: string }).name).toBe('My Phone');
    expect((requests[0]!.body as { name: string; platform: string }).platform).toBe('ios');
  });

  it('revoke: DELETE /api/devices/:id → 204', async () => {
    const { client, requests } = makeClient([{ status: 204, body: null }]);
    await client.devices.revoke('dev-1');
    expect(requests[0]!.method).toBe('DELETE');
    expect(requests[0]!.url).toContain('/api/devices/dev-1');
  });
});

describe('phone access routes', () => {
  const status = {
    enabled: true, serverId: 'a'.repeat(32), publicKey: 'b'.repeat(43),
    lan: { listening: true, port: 7778, addresses: ['192.168.1.20:7778'], error: null },
    relay: { url: null, status: 'off', error: null }, defaultRelayUrl: '',
  };

  it('status: GET /api/phone-access with the device token', async () => {
    const { client, requests } = makeClient([{ status: 200, body: status }]);
    expect(await client.phoneAccess.status()).toEqual(status);
    expect(requests[0]).toMatchObject({
      method: 'GET', url: 'http://localhost:7777/api/phone-access',
      headers: { authorization: 'Bearer test-token' },
    });
  });

  it('update: PATCH /api/phone-access preserves null and empty relay overrides', async () => {
    const { client, requests } = makeClient([{ status: 200, body: status }, { status: 200, body: status }]);
    expect(await client.phoneAccess.update({ enabled: false, relayUrl: null })).toEqual(status);
    await client.phoneAccess.update({ relayUrl: '' });
    expect(requests[0]).toMatchObject({ method: 'PATCH', body: { enabled: false, relayUrl: null } });
    expect(requests[1]).toMatchObject({ method: 'PATCH', body: { relayUrl: '' } });
  });

  it('update exposes owner-only errors', async () => {
    const { client } = makeClient([{ status: 403, body: { code: 'forbidden', message: 'Owner only' } }]);
    await expect(client.phoneAccess.update({ enabled: false })).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});

describe('pairing routes', () => {
  it('create: POST /api/pairing without a body', async () => {
    const session = { id: 'pair-1', code: 'a'.repeat(32), expiresAt: 300_000, pairingUrl: 'neo://pair?v=2&code=...' };
    const { client, requests } = makeClient([{ status: 201, body: session }]);
    expect(await client.pairing.create()).toEqual(session);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('http://localhost:7777/api/pairing');
    expect(requests[0]!.body).toBeUndefined();
    expect(requests[0]!.headers['authorization']).toBe('Bearer test-token');
  });

  it('cancel: DELETE /api/pairing/:id → 204', async () => {
    const { client, requests } = makeClient([{ status: 204, body: null }]);
    expect(await client.pairing.cancel('pair-1')).toBeUndefined();
    expect(requests[0]!.method).toBe('DELETE');
    expect(requests[0]!.url).toBe('http://localhost:7777/api/pairing/pair-1');
  });

  it('claim: POST /api/pairing/claim without a token', async () => {
    const response = { device: { id: 'dev-1', name: 'My Phone', platform: 'ios', owner: false }, token: 'phone-token' };
    const { fetchFn, requests } = makeFetch([{ status: 201, body: response }]);
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', fetch: fetchFn as typeof fetch });
    const body = { code: 'a'.repeat(32), deviceName: 'My Phone', platform: 'ios' as const };
    expect(await client.pairing.claim(body)).toEqual(response);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('http://localhost:7777/api/pairing/claim');
    expect(requests[0]!.body).toEqual(body);
    expect(requests[0]!.headers['authorization']).toBeUndefined();
  });
});

describe('push routes', () => {
  it('vapidPublicKey: GET /api/push/vapid-public-key', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { publicKey: 'BLR...' } }]);
    const key = await client.push.vapidPublicKey();
    expect(key).toBe('BLR...');
    expect(requests[0]!.url).toContain('/api/push/vapid-public-key');
  });

  it('vapidPublicKey returns null', async () => {
    const { client } = makeClient([{ status: 200, body: { publicKey: null } }]);
    const key = await client.push.vapidPublicKey();
    expect(key).toBeNull();
  });

  it('subscribe: POST /api/push/subscribe', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { ok: true } }]);
    const sub = { endpoint: 'https://push.example.com/sub', keys: { p256dh: 'abc', auth: 'def' } };
    await client.push.subscribe(sub as never);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/push/subscribe');
  });

  it('unsubscribe: POST /api/push/unsubscribe', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { ok: true } }]);
    await client.push.unsubscribe('https://push.example.com/sub');
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toContain('/api/push/unsubscribe');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SSE / readEventStream
// ─────────────────────────────────────────────────────────────────────────────

function sseChunks(lines: string[]): Uint8Array[] {
  return [new TextEncoder().encode(lines.join(''))];
}

function makeStreamResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collectEvents(response: Response, signal?: AbortSignal): Promise<import('@neo/protocol').AgentEvent[]> {
  const events: import('@neo/protocol').AgentEvent[] = [];
  for await (const ev of readEventStream(response, signal)) {
    events.push(ev);
  }
  return events;
}

describe('readEventStream SSE parsing', () => {
  it('parses a simple SSE stream', async () => {
    const event = { type: 'text.delta', episodeId: 'c1', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'hello' };
    const response = makeStreamResponse(
      sseChunks([`data: ${JSON.stringify(event)}\n\n`])
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it('propagates reader.read() errors as iterator rejections', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });
    const response = new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const iterator = readEventStream(response)[Symbol.asyncIterator]();
    const event = { type: 'text.delta', episodeId: 'c1', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'a' };

    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    const first = await iterator.next();
    expect(first.done).toBe(false);

    const failure = new TypeError('network drop');
    controller.error(failure);
    const next = iterator.next();
    await expect(next).rejects.toMatchObject({ name: 'NeoError', code: 'stream_read_failed' });
    const err = await next.catch((e: unknown) => e);
    expect((err as Error).cause).toBe(failure);
  });

  it('wraps reader.read() errors as NeoError(stream_read_failed)', async () => {
    const failure = new TypeError('network drop');
    const event = { type: 'text.delta', episodeId: 'c1', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'a' };
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        } else {
          controller.error(failure);
        }
      },
    }, { highWaterMark: 0 });
    const response = new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const collected = collectEvents(response);

    await expect(collected).rejects.toMatchObject({
      name: 'NeoError',
      code: 'stream_read_failed',
      retryable: true,
    });
    const err = await collected.catch((e: unknown) => e);
    expect((err as Error).cause).toBe(failure);
  });

  it('handles CRLF line endings', async () => {
    const event = { type: 'text.delta', episodeId: 'c1', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'world' };
    const response = makeStreamResponse(
      sseChunks([`data: ${JSON.stringify(event)}\r\n\r\n`])
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it('handles chunks split at line boundaries', async () => {
    const event = { type: 'text.delta', episodeId: 'c1', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'split' };
    const full = `data: ${JSON.stringify(event)}\n\n`;
    // Split at various points.
    const mid = Math.floor(full.length / 2);
    const chunks = [
      new TextEncoder().encode(full.slice(0, mid)),
      new TextEncoder().encode(full.slice(mid)),
    ];
    const response = makeStreamResponse(chunks);
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it('handles chunks split within the data field value', async () => {
    const event = { type: 'turn.finished', episodeId: 'c1', conversationId: 'c1', turnId: 't1', stopReason: 'end_turn', usage: null };
    const full = `data: ${JSON.stringify(event)}\n\n`;
    // Split at multiple points.
    const chunks = [
      new TextEncoder().encode(full.slice(0, 5)),
      new TextEncoder().encode(full.slice(5, 20)),
      new TextEncoder().encode(full.slice(20)),
    ];
    const response = makeStreamResponse(chunks);
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
  });

  it('ignores comment lines', async () => {
    const event = { type: 'text.delta', episodeId: 'c1', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'hi' };
    const response = makeStreamResponse(
      sseChunks([`: keepalive\ndata: ${JSON.stringify(event)}\n\n`])
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
  });

  it('handles multiple events in one chunk', async () => {
    const e1 = { type: 'text.delta', episodeId: 'c1', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'a' };
    const e2 = { type: 'text.delta', episodeId: 'c1', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'b' };
    const response = makeStreamResponse(
      sseChunks([`data: ${JSON.stringify(e1)}\n\ndata: ${JSON.stringify(e2)}\n\n`])
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(2);
    expect((events[0] as { text: string }).text).toBe('a');
    expect((events[1] as { text: string }).text).toBe('b');
  });

  it('ignores malformed JSON data', async () => {
    const valid = { type: 'text.delta', episodeId: 'c1', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'ok' };
    const response = makeStreamResponse(
      sseChunks([`data: not-json\n\ndata: ${JSON.stringify(valid)}\n\n`])
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
  });

  it('respects abort signal', async () => {
    const event = { type: 'text.delta', episodeId: 'c1', conversationId: 'c1', turnId: 't1', messageId: 'm1', text: 'x' };
    const ac = new AbortController();
    ac.abort(); // Pre-aborted.

    const response = makeStreamResponse(
      sseChunks([`data: ${JSON.stringify(event)}\n\n`])
    );
    const events = await collectEvents(response, ac.signal);
    expect(events).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fake WebSocket
// ─────────────────────────────────────────────────────────────────────────────

type WsHandler = (data: string) => void;

/** Minimal fake WebSocket for connect() tests. */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  url: string;

  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  private sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = FakeWebSocket.CLOSED;
  }

  getSentMessages(): string[] {
    return this.sentMessages;
  }

  // Test helpers: simulate server actions.
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  simulateClose(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    // Use a plain object instead of CloseEvent (not available in Node test env).
    const ev = { type: 'close', code, reason, wasClean: code === 1000 } as CloseEvent;
    this.onclose?.(ev);
  }
}

type FakeWsCtor = new (url: string) => FakeWebSocket;

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket connect() tests
// ─────────────────────────────────────────────────────────────────────────────

describe('connect() WebSocket', () => {
  let instances: FakeWebSocket[];
  let WsCtor: FakeWsCtor;

  beforeEach(() => {
    instances = [];
    WsCtor = class extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    } as unknown as FakeWsCtor;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeWsClient() {
    return new NeoClient({
      baseUrl: 'http://localhost:7777',
      token: 'ws-token',
      fetch: (() => Promise.reject(new Error('no fetch'))) as unknown as typeof fetch,
      WebSocket: WsCtor as unknown as typeof WebSocket,
    });
  }

  it('sends auth message after open', () => {
    const client = makeWsClient();
    const conn = client.connect({ onEvent: () => {} });
    expect(instances).toHaveLength(1);
    const ws = instances[0]!;

    ws.simulateOpen();
    const sent = ws.getSentMessages();
    expect(sent).toHaveLength(1);
    const authMsg = JSON.parse(sent[0]!) as { type: string; token: string };
    expect(authMsg.type).toBe('auth');
    expect(authMsg.token).toBe('ws-token');
    conn.close();
  });

  it('transitions to open after ready message', () => {
    const statuses: string[] = [];
    const client = makeWsClient();
    const conn = client.connect({
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
    });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 42 });

    expect(conn.status).toBe('open');
    expect(conn.lastSeq).toBe(42);
    expect(statuses).toContain('open');
    conn.close();
  });

  it('delivers event envelopes to onEvent', () => {
    const events: unknown[] = [];
    const client = makeWsClient();
    const conn = client.connect({ onEvent: (env) => events.push(env) });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });

    const envelope = { seq: 1, at: Date.now(), event: { type: 'settings.updated', settings: {} } };
    ws.simulateMessage({ type: 'event', envelope });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(envelope);
    expect(conn.lastSeq).toBe(1);
    conn.close();
  });

  it('delivers authoritative off-record changes from another client', () => {
    const events: unknown[] = [];
    const client = makeWsClient();
    const conn = client.connect({ onEvent: (env) => events.push(env) });
    const ws = instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });
    const envelope = { seq: 1, at: 42, event: { type: 'timeline.off_record', active: true } };
    ws.simulateMessage({ type: 'event', envelope });
    expect(events).toEqual([envelope]);
    conn.close();
  });

  it('subscribe sends subscribe message', () => {
    const client = makeWsClient();
    const conn = client.connect({ onEvent: () => {} });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });

    conn.subscribe(['conv-1', 'conv-2']);
    const msgs = ws.getSentMessages().map((m: string) => JSON.parse(m) as { type: string; conversations?: unknown });
    // The ready handler sends a subscribe with 'all'; conn.subscribe() sends another — check the last one.
    const subMsgs = msgs.filter((m) => m.type === 'subscribe');
    const subMsg = subMsgs[subMsgs.length - 1];
    expect(subMsg).toBeDefined();
    expect(subMsg!.conversations).toEqual(['conv-1', 'conv-2']);
    conn.close();
  });

  it('close() sets status to closed and does not reconnect', () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const client = makeWsClient();
    const conn = client.connect({
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
    });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });

    conn.close();
    expect(conn.status).toBe('closed');

    // Advance timers; no reconnect should happen.
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(1); // No new WebSocket created.
  });

  it('no reconnect after 4401 auth failure', () => {
    vi.useFakeTimers();
    const client = makeWsClient();
    const conn = client.connect({ onEvent: () => {} });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'error', error: { code: 'unauthorized', message: 'Bad token' } });
    ws.simulateClose(4401, 'auth failure');

    // Advance timers; no reconnect should happen.
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(1);
    expect(conn.status).toBe('closed');
  });

  it('reconnects with backoff on unexpected close', () => {
    vi.useFakeTimers();
    const client = makeWsClient();
    const conn = client.connect({ onEvent: () => {}, reconnect: true });
    const ws1 = instances[0]!;

    ws1.simulateOpen();
    ws1.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });

    // Unexpected close.
    ws1.simulateClose(1001, 'Going away');
    expect(instances).toHaveLength(1); // Still just 1.

    // Advance by 1.5s (within backoff range for first attempt).
    vi.advanceTimersByTime(1500);
    expect(instances).toHaveLength(2); // New socket created.

    conn.close();
  });

  it('reconnects again after a second failure (backoff increases)', () => {
    vi.useFakeTimers();
    const client = makeWsClient();
    const conn = client.connect({ onEvent: () => {}, reconnect: true });

    // First connection, fail immediately.
    instances[0]!.simulateOpen();
    instances[0]!.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });
    instances[0]!.simulateClose(1001, 'gone');

    vi.advanceTimersByTime(2000);
    expect(instances.length).toBeGreaterThanOrEqual(2);

    // Second connection, also fail.
    const ws2 = instances[instances.length - 1]!;
    ws2.simulateOpen();
    ws2.simulateClose(1001, 'gone again');

    // The backoff delay for attempt 2 is ~2s, so advance more.
    vi.advanceTimersByTime(5000);
    expect(instances.length).toBeGreaterThanOrEqual(3);

    conn.close();
  });

  it('no reconnect when reconnect: false', () => {
    vi.useFakeTimers();
    const client = makeWsClient();
    const conn = client.connect({ onEvent: () => {}, reconnect: false });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });
    ws.simulateClose(1006, 'network error');

    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(1); // No reconnect.
    conn.close();
  });

  it('status becomes closed and onStatus is called when reconnect:false and unexpected close', () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const client = makeWsClient();
    const conn = client.connect({
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      reconnect: false,
    });
    const ws = instances[0]!;

    ws.simulateOpen();
    ws.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });
    expect(conn.status).toBe('open');

    ws.simulateClose(1006, 'network error');

    expect(conn.status).toBe('closed');
    expect(statuses).toContain('closed');
    expect(instances).toHaveLength(1); // Still no reconnect.
  });

  it('resubscribes after reconnect', () => {
    vi.useFakeTimers();
    const client = makeWsClient();
    const conn = client.connect({
      onEvent: () => {},
      conversations: ['c1'],
      reconnect: true,
    });

    // First connection.
    const ws1 = instances[0]!;
    ws1.simulateOpen();
    ws1.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 0 });
    ws1.simulateClose(1001, 'gone');

    // Reconnect.
    vi.advanceTimersByTime(2000);
    const ws2 = instances[instances.length - 1]!;
    ws2.simulateOpen();
    ws2.simulateMessage({ type: 'ready', serverVersion: '0.1.0', seq: 1 });

    const msgs2 = ws2.getSentMessages().map((m: string) => JSON.parse(m) as { type: string; conversations?: string[] });
    const sub = msgs2.find((m) => m.type === 'subscribe');
    expect(sub).toBeDefined();
    expect(sub!.conversations).toEqual(['c1']);

    conn.close();
  });

  it('uses ws:// for http:// base URL', () => {
    const client = makeWsClient();
    client.connect({ onEvent: () => {} }).close();
    expect(instances[0]!.url).toContain('ws://localhost:7777/api/ws');
  });

  it('uses wss:// for https:// base URL', () => {
    const secureClient = new NeoClient({
      baseUrl: 'https://neo.example.com',
      token: 'tok',
      fetch: (() => Promise.reject(new Error('no'))) as unknown as typeof fetch,
      WebSocket: WsCtor as unknown as typeof WebSocket,
    });
    secureClient.connect({ onEvent: () => {} }).close();
    expect(instances[0]!.url).toContain('wss://neo.example.com/api/ws');
  });
});
