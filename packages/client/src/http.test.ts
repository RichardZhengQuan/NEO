import { describe, it, expect, vi } from 'vitest';
import { NeoClient, NeoApiError } from './index.js';
import { apiRequest } from './http.js';

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
