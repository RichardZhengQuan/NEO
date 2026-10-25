import { getEventListeners } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NeoClient, NeoApiError } from './index.js';
import { apiRequest } from './http.js';

describe('AbortSignal.any fallback', () => {
  let originalAny: PropertyDescriptor | undefined;
  let controller: AbortController;

  beforeEach(() => {
    originalAny = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', { configurable: true, writable: true, value: undefined });
    controller = new AbortController();
  });

  afterEach(() => {
    controller.abort();
    if (originalAny) {
      Object.defineProperty(AbortSignal, 'any', originalAny);
    } else {
      Reflect.deleteProperty(AbortSignal, 'any');
    }
  });

  it('rejects with AbortError when the caller signal is already aborted', async () => {
    controller.abort();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response('{}');
    });

    await expect(apiRequest({
      baseUrl: 'http://localhost:7777',
      token: undefined,
      fetch: fetchFn,
      timeoutMs: 30_000,
    }, { path: '/health', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toMatchObject({
      aborted: true,
      reason: controller.signal.reason,
    });
  });

  it('removes the caller abort listener when ctx.fetch() rejects (fetch-phase failure)', async () => {
    // Three sequential fetch-phase rejections on a shared signal must not grow the
    // listener count. Before the fix the onAbort listener leaked because the outer
    // finally only existed on the body-processing block; a fetch-phase rejection
    // exited through the first catch and never reached that finally.
    const baseline = getEventListeners(controller.signal, 'abort').length;
    expect(baseline).toBe(0);

    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network error'));
    const ctx = {
      baseUrl: 'http://localhost:7777',
      token: undefined,
      fetch: fetchFn,
      timeoutMs: 30_000,
    };

    for (let i = 0; i < 3; i++) {
      await expect(apiRequest(ctx, { path: '/health', signal: controller.signal })).rejects.toBeInstanceOf(NeoApiError);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(baseline);
    }
  });

  it('removes the caller abort listener after each of 100 successful requests', async () => {
    const baseline = getEventListeners(controller.signal, 'abort').length;
    expect(baseline).toBe(0);
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    const ctx = {
      baseUrl: 'http://localhost:7777',
      token: undefined,
      fetch: fetchFn,
      timeoutMs: 30_000,
    };

    for (let i = 0; i < 100; i++) {
      await expect(apiRequest(ctx, { path: '/health', signal: controller.signal })).resolves.toEqual({});
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(baseline);
    }

    expect(fetchFn).toHaveBeenCalledTimes(100);
  });
});

describe('Error cause preservation', () => {
  it('preserves TimeoutError as cause on a headers-phase timeout', async () => {
    const timeoutErr = new DOMException('Timeout', 'TimeoutError');
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(timeoutErr);

    const err = await apiRequest({
      baseUrl: 'http://localhost:7777',
      token: undefined,
      fetch: fetchFn,
      timeoutMs: 30_000,
    }, { path: '/health', timeout: false }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.httpStatus).toBe(504);
    expect(apiErr.code).toBe('timeout');
    expect(apiErr.cause).toBe(timeoutErr);
    expect((apiErr.cause as DOMException).name).toBe('TimeoutError');
  });

  it('preserves TimeoutError as cause on a body-phase timeout', async () => {
    const timeoutErr = new DOMException('Timeout', 'TimeoutError');
    const mockResponse = {
      ok: true,
      status: 200,
      text: vi.fn<() => Promise<string>>().mockRejectedValue(timeoutErr),
    } as unknown as Response;
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(mockResponse);

    const err = await apiRequest({
      baseUrl: 'http://localhost:7777',
      token: undefined,
      fetch: fetchFn,
      timeoutMs: 30_000,
    }, { path: '/data', timeout: false }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.httpStatus).toBe(504);
    expect(apiErr.code).toBe('timeout');
    expect(apiErr.cause).toBe(timeoutErr);
    expect((apiErr.cause as DOMException).name).toBe('TimeoutError');
  });

  it('preserves the body-parse error as cause when the error body is malformed', async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      json: vi.fn<() => Promise<unknown>>().mockRejectedValue(new SyntaxError('Unexpected token')),
    } as unknown as Response;
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(mockResponse);

    const err = await apiRequest({
      baseUrl: 'http://localhost:7777',
      token: undefined,
      fetch: fetchFn,
      timeoutMs: 30_000,
    }, { path: '/data', timeout: false }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.httpStatus).toBe(500);
    expect(apiErr.code).toBe('internal');
    expect(apiErr.cause).toBeInstanceOf(SyntaxError);
  });
});

describe('Network failure causes', () => {
  it('preserves the original fetch error and nested cause in apiRequest', async () => {
    const failure = new TypeError('fetch failed', { cause: new Error('cert') });
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(failure);

    const err = await apiRequest({
      baseUrl: 'http://localhost:7777',
      token: undefined,
      fetch: fetchFn,
      timeoutMs: 30_000,
    }, { path: '/health' }).catch((e: unknown) => e);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledWith('http://localhost:7777/api/health', expect.objectContaining({ method: 'GET' }));
    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.httpStatus).toBe(0);
    expect(apiErr.code).toBe('internal');
    expect(apiErr.message).toBe('fetch failed');
    expect(apiErr.retryable).toBe(true);
    expect(apiErr.cause).toBe(failure);
    expect(((apiErr.cause as TypeError).cause as Error).message).toBe('cert');
  });

  it('normalizes a mid-body stream failure into a NeoApiError (retryable network)', async () => {
    const stream = new ReadableStream({
      start(ctl) { ctl.error(new TypeError('terminated')); },
    });
    const response = new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
    const ctx = {
      baseUrl: 'http://localhost:7777',
      token: undefined,
      fetch: () => Promise.resolve(response),
      timeoutMs: 30_000,
    };
    const err = await apiRequest(ctx, { path: '/health' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeoApiError);
    expect((err as NeoApiError).code).toBe('internal');
    expect((err as NeoApiError).retryable).toBe(true);
    expect((err as NeoApiError).cause).toBeInstanceOf(TypeError);
  });

  it('preserves the original fetch error and nested cause in timeline.stream', async () => {
    const failure = new TypeError('fetch failed', { cause: new Error('cert') });
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(failure);
    const client = new NeoClient({ baseUrl: 'http://localhost:7777', fetch: fetchFn });

    const err = await client.timeline.stream({ text: 'hello' })[Symbol.asyncIterator]()
      .next().catch((e: unknown) => e);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledWith('http://localhost:7777/api/timeline/messages', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Accept: 'text/event-stream' }),
    }));
    expect(err).toBeInstanceOf(NeoApiError);
    const apiErr = err as NeoApiError;
    expect(apiErr.httpStatus).toBe(0);
    expect(apiErr.code).toBe('internal');
    expect(apiErr.message).toBe('fetch failed');
    expect(apiErr.retryable).toBe(true);
    expect(apiErr.cause).toBe(failure);
    expect(((apiErr.cause as TypeError).cause as Error).message).toBe('cert');
  });
});
