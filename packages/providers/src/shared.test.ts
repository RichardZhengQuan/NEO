import { describe, expect, it } from 'vitest';
import { NeoError } from '@neo/protocol';
import type { ProviderConfig } from '@neo/protocol';
import { createProvider, createProviderRegistry, parseSSE, withRetry } from './index.js';
import { parseRetryAfter, redact } from './shared.js';
import { abortError, byteStream } from './testing/http.js';

async function messages(chunks: string[]) {
  const out: { data: string; event?: string; id?: string }[] = [];
  for await (const m of parseSSE(byteStream(chunks))) out.push(m);
  return out;
}

describe('parseSSE edge cases', () => {
  it('handles lone CR line endings and CRLF split across chunks', async () => {
    expect(await messages(['data: a\rdata: b\r\r'])).toEqual([{ data: 'a\nb' }]);
    expect(await messages(['data: x\r', '\n\r', '\ndata: y\r\n\r\n'])).toEqual([{ data: 'x' }, { data: 'y' }]);
  });

  it('dispatches a final event that lacks the trailing blank line, and strips a BOM', async () => {
    expect(await messages(['﻿data: first\n\n', 'data: last'])).toEqual([{ data: 'first' }, { data: 'last' }]);
  });

  it('keeps the last event id across events and resets the event type', async () => {
    expect(await messages(['id: 7\nevent: a\ndata: 1\n\ndata: 2\n\n'])).toEqual([
      { data: '1', event: 'a', id: '7' },
      { data: '2', id: '7' },
    ]);
  });

  it('abort ends the iteration even when the body ignores the signal', async () => {
    const ac = new AbortController();
    const it = parseSSE(byteStream(['data: one\n\n'], { hang: true }), ac.signal)[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ data: 'one' });
    setTimeout(() => ac.abort(), 5);
    await expect(it.next()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('leaving the loop early cancels the body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const m of parseSSE(body)) {
      expect(m.data).toBe('1');
      break;
    }
    expect(cancelled).toBe(true);
  });
});

describe('withRetry', () => {
  const resp = (status: number, headers: Record<string, string> = {}) => new Response(status === 204 ? null : 'x', { status, headers });

  it('does not wait out a retry-after above 10 s (the caller reports rate_limited)', async () => {
    const delays: number[] = [];
    let calls = 0;
    const r = await withRetry({
      attempt: async () => {
        calls++;
        return resp(429, { 'retry-after': '11' });
      },
      sleep: async (ms) => void delays.push(ms),
    });
    expect(r.status).toBe(429);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('uses 0.5 s then 1.5 s backoff and never retries other 4xx', async () => {
    const delays: number[] = [];
    let calls = 0;
    const r = await withRetry({ attempt: async () => (++calls < 3 ? resp(502) : resp(200)), sleep: async (ms) => void delays.push(ms) });
    expect(r.status).toBe(200);
    expect(delays).toEqual([500, 1500]);
    for (const status of [400, 401, 404, 408, 409]) {
      let n = 0;
      expect((await withRetry({ attempt: async () => (n++, resp(status)), sleep: async () => {} })).status).toBe(status);
      expect(n).toBe(1);
    }
  });

  it('retries at most twice even when asked for more', async () => {
    let calls = 0;
    const r = await withRetry({ attempt: async () => (calls++, resp(500)), maxRetries: 5, sleep: async () => {} });
    expect(r.status).toBe(500);
    expect(calls).toBe(3);
  });

  it('abort during the backoff wait ends immediately with cancelled', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 5);
    await expect(withRetry({ attempt: async () => resp(503), signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('an aborted fetch is cancelled, not retried', async () => {
    let calls = 0;
    await expect(
      withRetry({
        attempt: async () => {
          calls++;
          throw abortError();
        },
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toBe(1);
  });

  it('reports the network cause after exhausting retries', async () => {
    const err = await withRetry({
      attempt: async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND api.example.com') });
      },
      sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeoError);
    expect(err).toMatchObject({ code: 'provider_error', retryable: true, message: expect.stringContaining('ENOTFOUND') });
  });

  it('cancels the bodies of responses it discards', async () => {
    let cancelled = 0;
    const body = () => new ReadableStream({ cancel: () => void cancelled++ });
    let calls = 0;
    await withRetry({ attempt: async () => (++calls < 3 ? new Response(body(), { status: 500 }) : resp(200)), sleep: async () => {} });
    expect(cancelled).toBe(2);
  });
});

describe('helpers', () => {
  it('parseRetryAfter reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0.5')).toBe(500);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:30 GMT'))).toBe(30_000);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('redact removes every occurrence of each secret', () => {
    expect(redact('key sk-abcdef and sk-abcdef', ['sk-abcdef', undefined])).toBe('key [redacted] and [redacted]');
  });
});

describe('createProvider / registry', () => {
  const disabled: ProviderConfig = { id: 'off', kind: 'mock', enabled: false, label: 'Disabled test provider' };

  it('adapter.config is the very config passed in (no secrets copied in)', () => {
    const config: ProviderConfig = { id: 'o', kind: 'openai', apiKeySecret: 'provider:o', enabled: true };
    const adapter = createProvider(config, { resolveSecret: () => 'sk-secret-value' });
    expect(adapter.config).toBe(config);
    expect(JSON.stringify(adapter.config)).not.toContain('sk-secret-value');
  });

  it('keeps disabled providers as they are, and resolve() refuses them', () => {
    const registry = createProviderRegistry([disabled, { id: 'test-mock', kind: 'mock', enabled: true }], { mockScript: () => ({ text: 'Test reply' }) });
    expect(registry.get('off')?.config).toBe(disabled);
    expect(registry.get('off')?.config.enabled).toBe(false);
    expect(registry.list().map((a) => a.id)).toEqual(['off', 'test-mock']);
    expect(() => registry.resolve({ provider: 'off', model: 'neo-test' })).toThrow(expect.objectContaining({ code: 'config_error' }));
    expect(() => registry.resolve({ provider: 'nope', model: 'x' })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(registry.resolve({ provider: 'test-mock', model: 'neo-test' }).model).toBe('neo-test');
  });

  it('re-enabling via upsert makes resolve() work; a failing upsert leaves the registry unchanged', () => {
    const registry = createProviderRegistry([disabled], { mockScript: () => ({ text: 'Test reply' }) });
    const before = registry.get('off');
    expect(() => registry.upsert({ ...disabled, kind: 'nope' as never })).toThrow(NeoError);
    expect(registry.get('off')).toBe(before);
    registry.upsert({ ...disabled, enabled: true });
    expect(registry.resolve({ provider: 'off', model: 'neo-test' }).adapter.config.enabled).toBe(true);
  });

  it('isLocal follows config.local, the kind and the base URL', () => {
    expect(createProvider({ id: 'a', kind: 'ollama', baseUrl: 'https://ollama.example.com', enabled: true }).isLocal).toBe(true);
    expect(createProvider({ id: 'b', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', enabled: true }).isLocal).toBe(false);
    expect(createProvider({ id: 'c', kind: 'openai-compatible', baseUrl: 'http://192.168.1.20:8000/v1', enabled: true }).isLocal).toBe(true);
    expect(createProvider({ id: 'd', kind: 'gemini', enabled: true, local: true }).isLocal).toBe(true);
    expect(createProvider({ id: 'e', kind: 'mock', enabled: true }, { mockScript: () => ({ text: 'Test reply' }) }).isLocal).toBe(true);
  });
});
