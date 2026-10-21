import { describe, it, expect, vi } from 'vitest';
import { NeoClient, NeoApiError } from './index.js';
import { apiRequest } from './http.js';

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
