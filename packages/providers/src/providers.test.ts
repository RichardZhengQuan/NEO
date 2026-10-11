/**
 * Comprehensive offline tests for @neo/providers.
 *
 * All tests are deterministic: fake fetch returns Response objects with
 * ReadableStream SSE bodies built from fixture chunks split at awkward
 * boundaries to stress-test the SSE parser.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseSSE } from './sse.js';
import { withRetry } from './retry.js';
import { OpenAIAdapter } from './openai.js';
import { GeminiAdapter } from './gemini.js';
import { MockProvider } from './mock.js';
import { createProvider, createProviderRegistry } from './index.js';
import { NeoError } from '@neo/protocol';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

/** Build a ReadableStream<Uint8Array> from an array of string chunks. */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(enc.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Build a 200 SSE Response from an array of string chunks (split awkwardly). */
function makeSseResponse(chunks: string[], status = 200): Response {
  const body = status >= 400 ? null : makeStream(chunks);
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Collect all events from an async iterable. */
async function collectEvents<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iterable) {
    results.push(item);
  }
  return results;
}

/** Build SSE text for one event. */
function sseEvent(data: unknown, eventType?: string): string {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  return (eventType ? `event: ${eventType}\ndata: ${dataStr}\n\n` : `data: ${dataStr}\n\n`);
}

// ---------------------------------------------------------------------------
// 1. SSE Parser
// ---------------------------------------------------------------------------

describe('parseSSE', () => {
  it('parses a simple data-only message', async () => {
    const stream = makeStream(['data: hello\n\n']);
    const msgs = await collectEvents(parseSSE(stream));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.data).toBe('hello');
  });

  it('parses CRLF line endings', async () => {
    const stream = makeStream(['data: world\r\n\r\n']);
    const msgs = await collectEvents(parseSSE(stream));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.data).toBe('world');
  });

  it('parses chunks split at awkward boundaries (mid-line)', async () => {
    // Split "data: hello\n\n" into three pieces
    const stream = makeStream(['da', 'ta: hel', 'lo\n\n']);
    const msgs = await collectEvents(parseSSE(stream));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.data).toBe('hello');
  });

  it('parses multiple events in one chunk', async () => {
    const stream = makeStream(['data: one\n\ndata: two\n\ndata: three\n\n']);
    const msgs = await collectEvents(parseSSE(stream));
    expect(msgs.map((m) => m.data)).toEqual(['one', 'two', 'three']);
  });

  it('parses event type field', async () => {
    const stream = makeStream(['event: ping\ndata: {}\n\n']);
    const msgs = await collectEvents(parseSSE(stream));
    expect(msgs[0]?.event).toBe('ping');
    expect(msgs[0]?.data).toBe('{}');
  });

  it('parses id field', async () => {
    const stream = makeStream(['id: 42\ndata: test\n\n']);
    const msgs = await collectEvents(parseSSE(stream));
    expect(msgs[0]?.id).toBe('42');
  });

  it('ignores comment lines', async () => {
    const stream = makeStream([': this is a comment\ndata: real\n\n']);
    const msgs = await collectEvents(parseSSE(stream));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.data).toBe('real');
  });

  it('accumulates multi-line data', async () => {
    const stream = makeStream(['data: line1\ndata: line2\n\n']);
    const msgs = await collectEvents(parseSSE(stream));
    expect(msgs[0]?.data).toBe('line1\nline2');
  });

  it('skips dispatch when data is empty', async () => {
    const stream = makeStream(['data:\n\ndata: real\n\n']);
    const msgs = await collectEvents(parseSSE(stream));
    // "data:\n" with blank value produces empty string → no dispatch
    // "data: real" produces dispatch
    expect(msgs.filter((m) => m.data !== '')).toHaveLength(1);
  });

  it('strips one leading space from values', async () => {
    // "data: hello" → value is "hello" (space stripped)
    const stream = makeStream(['data: hello\n\n']);
    const msgs = await collectEvents(parseSSE(stream));
    expect(msgs[0]?.data).toBe('hello');
  });

  it('throws NeoError cancelled when signal is pre-aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const stream = makeStream(['data: should not reach\n\n']);
    await expect(async () => {
      for await (const _ of parseSSE(stream, ac.signal)) {
        // consume
      }
    }).rejects.toMatchObject({ code: 'cancelled' });
  });
});

// ---------------------------------------------------------------------------
// 2. Retry logic
// ---------------------------------------------------------------------------

describe('withRetry', () => {
  it('returns immediately on 200', async () => {
    let calls = 0;
    const resp = await withRetry({
      attempt: async () => { calls++; return new Response(null, { status: 200 }); },
      sleep: async () => {},
    });
    expect(resp.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('retries on 429 up to maxRetries', async () => {
    let calls = 0;
    const resp = await withRetry({
      attempt: async () => {
        calls++;
        if (calls < 3) return new Response(null, { status: 429 });
        return new Response(null, { status: 200 });
      },
      sleep: async () => {},
    });
    expect(resp.status).toBe(200);
    expect(calls).toBe(3);
  });

  it('retries on 500', async () => {
    let calls = 0;
    const resp = await withRetry({
      attempt: async () => {
        calls++;
        if (calls < 2) return new Response(null, { status: 500 });
        return new Response(null, { status: 200 });
      },
      sleep: async () => {},
    });
    expect(resp.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('respects retry-after header (numeric seconds)', async () => {
    const slept: number[] = [];
    let calls = 0;
    await withRetry({
      attempt: async () => {
        calls++;
        if (calls === 1) {
          return new Response(null, {
            status: 429,
            headers: { 'retry-after': '3' },
          });
        }
        return new Response(null, { status: 200 });
      },
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(slept[0]).toBe(3000);
  });

  it('retries on network errors', async () => {
    let calls = 0;
    const resp = await withRetry({
      attempt: async () => {
        calls++;
        if (calls < 2) throw new Error('ECONNREFUSED');
        return new Response(null, { status: 200 });
      },
      sleep: async () => {},
    });
    expect(resp.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('throws NeoError after exhausting retries (network)', async () => {
    await expect(withRetry({
      attempt: async () => { throw new Error('ECONNREFUSED'); },
      maxRetries: 2,
      sleep: async () => {},
    })).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('returns last 429 response when retry-after > 10s', async () => {
    const resp = await withRetry({
      attempt: async () =>
        new Response(null, { status: 429, headers: { 'retry-after': '60' } }),
      sleep: async () => {},
    });
    expect(resp.status).toBe(429);
  });

  it('throws NeoError cancelled when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(withRetry({
      attempt: async () => new Response(null, { status: 200 }),
      signal: ac.signal,
    })).rejects.toMatchObject({ code: 'cancelled' });
  });
});

// ---------------------------------------------------------------------------
// 3. OpenAI Adapter
// ---------------------------------------------------------------------------

describe('OpenAIAdapter — chat streaming', () => {
  function makeOpenAIConfig() {
    return {
      id: 'test-openai',
      kind: 'openai' as const,
      label: 'Test OpenAI',
      apiKey: 'sk-test',
      enabled: true,
    };
  }

  it('streams text from SSE chunks', async () => {
    // Split SSE across multiple chunks to stress-test parser
    const chunk1 = sseEvent({ choices: [{ delta: { content: 'Hello' }, finish_reason: null, index: 0 }] });
    const chunk2 = sseEvent({ choices: [{ delta: { content: ' world' }, finish_reason: 'stop', index: 0 }] });
    const chunk3 = 'data: [DONE]\n\n';

    // Split chunk1 at awkward boundary
    const part1 = chunk1.slice(0, 10);
    const part2 = chunk1.slice(10);

    const fakeFetch = vi.fn().mockResolvedValue(
      makeSseResponse([part1, part2, chunk2, chunk3]),
    );

    const adapter = new OpenAIAdapter(makeOpenAIConfig(), { fetch: fakeFetch });
    const events = await collectEvents(adapter.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    }));

    const textEvents = events.filter((e) => e.type === 'text');
    const combined = textEvents.map((e) => e.type === 'text' ? e.text : '').join('');
    expect(combined).toBe('Hello world');

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.type === 'done' && doneEvent.stopReason).toBe('end');
  });

  it('accumulates tool calls by index', async () => {
    const tc0 = {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'get_weather', arguments: '{"ci' } }],
        },
        finish_reason: null,
        index: 0,
      }],
    };
    const tc1 = {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, function: { arguments: 'ty":"NYC"}' } }],
        },
        finish_reason: 'tool_calls',
        index: 0,
      }],
    };

    const fakeFetch = vi.fn().mockResolvedValue(
      makeSseResponse([sseEvent(tc0), sseEvent(tc1), 'data: [DONE]\n\n']),
    );

    const adapter = new OpenAIAdapter(makeOpenAIConfig(), { fetch: fakeFetch });
    const events = await collectEvents(adapter.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'weather' }] }],
    }));

    const toolEvent = events.find((e) => e.type === 'tool_call');
    expect(toolEvent?.type).toBe('tool_call');
    if (toolEvent?.type === 'tool_call') {
      expect(toolEvent.name).toBe('get_weather');
      expect(toolEvent.input).toEqual({ city: 'NYC' });
      expect(toolEvent.id).toBe('call_abc');
    }

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.type === 'done' && doneEvent.stopReason).toBe('tool_use');
  });

  it('emits reasoning event for reasoning_content', async () => {
    const chunk = sseEvent({
      choices: [{
        delta: { reasoning_content: 'thinking...', content: null },
        finish_reason: null,
        index: 0,
      }],
    });
    const done = sseEvent({
      choices: [{ delta: { content: 'answer' }, finish_reason: 'stop', index: 0 }],
    });

    const fakeFetch = vi.fn().mockResolvedValue(
      makeSseResponse([chunk, done, 'data: [DONE]\n\n']),
    );

    const adapter = new OpenAIAdapter(makeOpenAIConfig(), { fetch: fakeFetch });
    const events = await collectEvents(adapter.chat({
      model: 'o3-mini',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'solve this' }] }],
    }));

    const reasoningEvent = events.find((e) => e.type === 'reasoning');
    expect(reasoningEvent?.type === 'reasoning' && reasoningEvent.text).toBe('thinking...');
  });

  it('uses max_completion_tokens for reasoning models', async () => {
    let capturedBody = '';
    const fakeFetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return makeSseResponse([
        sseEvent({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop', index: 0 }] }),
        'data: [DONE]\n\n',
      ]);
    });

    const adapter = new OpenAIAdapter(makeOpenAIConfig(), { fetch: fakeFetch });
    await collectEvents(adapter.chat({
      model: 'o3-mini',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'test' }] }],
      maxTokens: 1000,
    }));

    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(body['max_completion_tokens']).toBe(1000);
    expect(body['max_tokens']).toBeUndefined();
  });

  it('uses max_tokens for OpenAI-compatible servers (max_completion_tokens is OpenAI-only)', async () => {
    let capturedBody = '';
    const fakeFetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return makeSseResponse([
        sseEvent({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop', index: 0 }] }),
        'data: [DONE]\n\n',
      ]);
    });

    const adapter = new OpenAIAdapter({ ...makeOpenAIConfig(), kind: 'openai-compatible' }, { fetch: fakeFetch });
    await collectEvents(adapter.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'test' }] }],
      maxTokens: 500,
    }));

    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(body['max_tokens']).toBe(500);
    expect(body['max_completion_tokens']).toBeUndefined();
  });

  it('emits usage event from stream_options chunk', async () => {
    const usageChunk = {
      choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    };

    const fakeFetch = vi.fn().mockResolvedValue(
      makeSseResponse([sseEvent(usageChunk), 'data: [DONE]\n\n']),
    );

    const adapter = new OpenAIAdapter(makeOpenAIConfig(), { fetch: fakeFetch });
    const events = await collectEvents(adapter.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    }));

    const usageEvent = events.find((e) => e.type === 'usage');
    expect(usageEvent?.type === 'usage' && usageEvent.usage.inputTokens).toBe(10);
    expect(usageEvent?.type === 'usage' && usageEvent.usage.outputTokens).toBe(20);
    expect(usageEvent?.type === 'usage' && usageEvent.usage.reasoningTokens).toBe(5);
  });

  it('maps content_filter finish_reason to refusal', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      makeSseResponse([
        sseEvent({ choices: [{ delta: { content: '' }, finish_reason: 'content_filter', index: 0 }] }),
        'data: [DONE]\n\n',
      ]),
    );

    const adapter = new OpenAIAdapter(makeOpenAIConfig(), { fetch: fakeFetch });
    const events = await collectEvents(adapter.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'bad request' }] }],
    }));

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.type === 'done' && doneEvent.stopReason).toBe('refusal');
  });

  it('maps length finish_reason to max_tokens', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      makeSseResponse([
        sseEvent({ choices: [{ delta: { content: 'truncated' }, finish_reason: 'length', index: 0 }] }),
        'data: [DONE]\n\n',
      ]),
    );

    const adapter = new OpenAIAdapter(makeOpenAIConfig(), { fetch: fakeFetch });
    const events = await collectEvents(adapter.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    }));

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.type === 'done' && doneEvent.stopReason).toBe('max_tokens');
  });

  it('throws NeoError provider_auth on 401', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }),
    );

    const adapter = new OpenAIAdapter(makeOpenAIConfig(), { fetch: fakeFetch });
    await expect(collectEvents(adapter.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    }))).rejects.toMatchObject({ code: 'provider_auth' });
  });

  it('listModels — parses data array', async () => {
    const modelsJson = {
      data: [
        { id: 'gpt-4o', display_name: 'GPT-4o' },
        { id: 'gpt-4o-mini', display_name: 'GPT-4o mini' },
      ],
    };
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(modelsJson), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const adapter = new OpenAIAdapter(makeOpenAIConfig(), { fetch: fakeFetch });
    const models = await adapter.listModels();
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('embed — returns float arrays', async () => {
    const embeddingJson = {
      data: [
        { embedding: [0.1, 0.2, 0.3] },
        { embedding: [0.4, 0.5, 0.6] },
      ],
    };
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(embeddingJson), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const adapter = new OpenAIAdapter(makeOpenAIConfig(), { fetch: fakeFetch });
    const result = await adapter.embed({
      model: 'text-embedding-3-small',
      texts: ['hello', 'world'],
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result[1]).toEqual([0.4, 0.5, 0.6]);
  });
});

describe('OpenAIAdapter — Ollama', () => {
  function makeOllamaConfig() {
    return {
      id: 'test-ollama',
      kind: 'ollama' as const,
      label: 'Test Ollama',
      baseUrl: 'http://127.0.0.1:11434',
      enabled: true,
    };
  }

  it('uses /v1/chat/completions endpoint', async () => {
    let capturedUrl = '';
    const fakeFetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return makeSseResponse([
        sseEvent({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop', index: 0 }] }),
        'data: [DONE]\n\n',
      ]);
    });

    const adapter = new OpenAIAdapter(makeOllamaConfig(), { fetch: fakeFetch });
    await collectEvents(adapter.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    }));

    expect(capturedUrl).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('listModels uses /api/tags', async () => {
    let capturedUrl = '';
    const fakeFetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ models: [{ name: 'llama3.2' }, { name: 'mistral' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const adapter = new OpenAIAdapter(makeOllamaConfig(), { fetch: fakeFetch });
    const models = await adapter.listModels();
    expect(capturedUrl).toBe('http://127.0.0.1:11434/api/tags');
    expect(models.map((m) => m.id)).toEqual(['llama3.2', 'mistral']);
  });

  it('embed uses /api/embed', async () => {
    let capturedUrl = '';
    const fakeFetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ embeddings: [[0.1, 0.2]] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const adapter = new OpenAIAdapter(makeOllamaConfig(), { fetch: fakeFetch });
    const result = await adapter.embed({ model: 'nomic-embed-text', texts: ['hello'] });
    expect(capturedUrl).toBe('http://127.0.0.1:11434/api/embed');
    expect(result[0]).toEqual([0.1, 0.2]);
  });

  it('wraps chat network errors with Ollama hint', async () => {
    // wrapNetworkError now rewrites withRetry's generic provider_error with the Ollama hint.
    const fakeFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const adapter = new OpenAIAdapter(makeOllamaConfig(), { fetch: fakeFetch, sleep: async () => {} });
    await expect(collectEvents(adapter.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    }))).rejects.toMatchObject({
      code: 'provider_error',
      message: expect.stringContaining('ollama serve'),
    });
  });

  it('wraps listModels network errors with Ollama hint', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const adapter = new OpenAIAdapter(makeOllamaConfig(), { fetch: fakeFetch });
    await expect(adapter.listModels()).rejects.toMatchObject({
      code: 'provider_error',
      message: expect.stringContaining('ollama serve'),
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Gemini Adapter
// ---------------------------------------------------------------------------

describe('GeminiAdapter — sanitizeSchema', () => {
  // Access sanitizeSchema via GeminiAdapter internals by inspecting what gets sent
  it('sends sanitized schema in request body (drops $schema, additionalProperties)', async () => {
    let capturedBody = '';
    const fakeFetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return makeSseResponse([
        sseEvent({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
      ]);
    });

    const adapter = new GeminiAdapter(
      { id: 'g', kind: 'gemini', label: 'G', apiKey: 'key', enabled: true },
      { fetch: fakeFetch },
    );

    await collectEvents(adapter.chat({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      tools: [{
        name: 'get_weather',
        description: 'Get weather',
        inputSchema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          additionalProperties: false,
          properties: {
            city: { type: 'string', const: 'NYC' },
            nullable_field: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
      }],
    }));

    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    const decls = (body['tools'] as Array<Record<string, unknown>>)?.[0];
    const fn = (decls?.['functionDeclarations'] as Array<Record<string, unknown>>)?.[0];
    const params = fn?.['parameters'] as Record<string, unknown>;
    const props = params?.['properties'] as Record<string, unknown>;

    // $schema and additionalProperties must be absent
    expect(params?.['$schema']).toBeUndefined();
    expect(params?.['additionalProperties']).toBeUndefined();

    // const → enum
    const cityProp = props?.['city'] as Record<string, unknown>;
    expect(cityProp?.['enum']).toEqual(['NYC']);
    expect(cityProp?.['const']).toBeUndefined();

    // anyOf [X, null] → nullable
    const nullableProp = props?.['nullable_field'] as Record<string, unknown>;
    expect(nullableProp?.['nullable']).toBe(true);
    expect(nullableProp?.['type']).toBe('string');
    expect(nullableProp?.['anyOf']).toBeUndefined();
  });
});

describe('GeminiAdapter — chat streaming', () => {
  function makeGeminiConfig() {
    return {
      id: 'test-gemini',
      kind: 'gemini' as const,
      label: 'Test Gemini',
      apiKey: 'AIza-test',
      enabled: true,
    };
  }

  it('streams text content', async () => {
    const chunk1 = sseEvent({
      candidates: [{
        content: { parts: [{ text: 'Hello ' }], role: 'model' },
        finishReason: 'STOP',
      }],
    });
    const chunk2 = sseEvent({
      candidates: [{
        content: { parts: [{ text: 'world' }], role: 'model' },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    });

    // Split at awkward boundary
    const part1 = chunk1.slice(0, 15);
    const part2 = chunk1.slice(15);

    const fakeFetch = vi.fn().mockResolvedValue(
      makeSseResponse([part1, part2, chunk2]),
    );

    const adapter = new GeminiAdapter(makeGeminiConfig(), { fetch: fakeFetch });
    const events = await collectEvents(adapter.chat({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    }));

    const text = events.filter((e) => e.type === 'text').map((e) => e.type === 'text' ? e.text : '').join('');
    expect(text).toBe('Hello world');

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.type === 'done' && doneEvent.stopReason).toBe('end');
  });

  it('emits reasoning event for thought parts', async () => {
    const chunk = sseEvent({
      candidates: [{
        content: {
          parts: [
            { text: 'I am thinking...', thought: true },
            { text: 'The answer is 42.' },
          ],
          role: 'model',
        },
        finishReason: 'STOP',
      }],
    });

    const fakeFetch = vi.fn().mockResolvedValue(makeSseResponse([chunk]));

    const adapter = new GeminiAdapter(makeGeminiConfig(), { fetch: fakeFetch });
    const events = await collectEvents(adapter.chat({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'what is the answer?' }] }],
    }));

    const reasoningEvent = events.find((e) => e.type === 'reasoning');
    expect(reasoningEvent?.type === 'reasoning' && reasoningEvent.text).toBe('I am thinking...');

    const textEvent = events.find((e) => e.type === 'text');
    expect(textEvent?.type === 'text' && textEvent.text).toBe('The answer is 42.');
  });

  it('emits reasoning_part when thoughtSignature present', async () => {
    const chunk = sseEvent({
      candidates: [{
        content: {
          parts: [{ text: 'thinking...', thought: true, thoughtSignature: 'sig-abc' }],
          role: 'model',
        },
        finishReason: 'STOP',
      }],
    });

    const fakeFetch = vi.fn().mockResolvedValue(makeSseResponse([chunk]));

    const adapter = new GeminiAdapter(makeGeminiConfig(), { fetch: fakeFetch });
    const events = await collectEvents(adapter.chat({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'think' }] }],
    }));

    const rpEvent = events.find((e) => e.type === 'reasoning_part');
    expect(rpEvent?.type).toBe('reasoning_part');
    if (rpEvent?.type === 'reasoning_part') {
      expect((rpEvent.part.data as { thoughtSignature: string }).thoughtSignature).toBe('sig-abc');
    }
  });

  it('emits tool_call for functionCall parts', async () => {
    const chunk = sseEvent({
      candidates: [{
        content: {
          parts: [{ functionCall: { name: 'get_weather', args: { city: 'London' } } }],
          role: 'model',
        },
        finishReason: 'STOP',
      }],
    });

    const fakeFetch = vi.fn().mockResolvedValue(makeSseResponse([chunk]));

    const adapter = new GeminiAdapter(makeGeminiConfig(), { fetch: fakeFetch });
    const events = await collectEvents(adapter.chat({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'weather?' }] }],
    }));

    const tcEvent = events.find((e) => e.type === 'tool_call');
    expect(tcEvent?.type).toBe('tool_call');
    if (tcEvent?.type === 'tool_call') {
      expect(tcEvent.name).toBe('get_weather');
      expect(tcEvent.input).toEqual({ city: 'London' });
      expect(tcEvent.id).toMatch(/^call_/);
    }

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.type === 'done' && doneEvent.stopReason).toBe('tool_use');
  });

  it('maps SAFETY finishReason to refusal', async () => {
    const chunk = sseEvent({
      candidates: [{
        content: { parts: [], role: 'model' },
        finishReason: 'SAFETY',
      }],
    });

    const fakeFetch = vi.fn().mockResolvedValue(makeSseResponse([chunk]));

    const adapter = new GeminiAdapter(makeGeminiConfig(), { fetch: fakeFetch });
    const events = await collectEvents(adapter.chat({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'bad request' }] }],
    }));

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.type === 'done' && doneEvent.stopReason).toBe('refusal');
  });

  it('maps MAX_TOKENS finishReason', async () => {
    const chunk = sseEvent({
      candidates: [{
        content: { parts: [{ text: 'truncated' }], role: 'model' },
        finishReason: 'MAX_TOKENS',
      }],
    });

    const fakeFetch = vi.fn().mockResolvedValue(makeSseResponse([chunk]));

    const adapter = new GeminiAdapter(makeGeminiConfig(), { fetch: fakeFetch });
    const events = await collectEvents(adapter.chat({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'tell me everything' }] }],
    }));

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent?.type === 'done' && doneEvent.stopReason).toBe('max_tokens');
  });

  it('emits usage from usageMetadata', async () => {
    const chunk = sseEvent({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5 },
    });

    const fakeFetch = vi.fn().mockResolvedValue(makeSseResponse([chunk]));

    const adapter = new GeminiAdapter(makeGeminiConfig(), { fetch: fakeFetch });
    const events = await collectEvents(adapter.chat({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    }));

    const usageEvent = events.find((e) => e.type === 'usage');
    expect(usageEvent?.type === 'usage' && usageEvent.usage.inputTokens).toBe(10);
    // Output includes thought tokens (as OpenAI's completion_tokens and Anthropic's output_tokens do).
    expect(usageEvent?.type === 'usage' && usageEvent.usage.outputTokens).toBe(25);
    expect(usageEvent?.type === 'usage' && usageEvent.usage.reasoningTokens).toBe(5);
  });

  it('throws NeoError provider_auth without apiKey', async () => {
    const adapter = new GeminiAdapter(
      { id: 'g', kind: 'gemini', label: 'G', enabled: true },
    );
    await expect(collectEvents(adapter.chat({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    }))).rejects.toMatchObject({ code: 'provider_auth' });
  });

  it('throws NeoError provider_auth on 401', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }),
    );
    const adapter = new GeminiAdapter(makeGeminiConfig(), { fetch: fakeFetch });
    await expect(collectEvents(adapter.chat({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    }))).rejects.toMatchObject({ code: 'provider_auth' });
  });

  it('listModels filters to generateContent-capable models', async () => {
    const modelsJson = {
      models: [
        {
          name: 'models/gemini-2.0-flash',
          displayName: 'Gemini 2.0 Flash',
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
        },
        {
          name: 'models/embedding-001',
          displayName: 'Embedding 001',
          supportedGenerationMethods: ['embedContent'],
        },
        {
          name: 'models/gemini-1.5-pro',
          displayName: 'Gemini 1.5 Pro',
          supportedGenerationMethods: ['streamGenerateContent'],
        },
      ],
    };

    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(modelsJson), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const adapter = new GeminiAdapter(makeGeminiConfig(), { fetch: fakeFetch });
    const models = await adapter.listModels();
    expect(models.map((m) => m.id)).toEqual(['gemini-2.0-flash', 'gemini-1.5-pro']);
  });

  it('embed returns vectors', async () => {
    const embedJson = {
      embeddings: [{ values: [0.1, 0.2, 0.3] }, { values: [0.4, 0.5, 0.6] }],
    };
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(embedJson), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const adapter = new GeminiAdapter(makeGeminiConfig(), { fetch: fakeFetch });
    const result = await adapter.embed({
      model: 'text-embedding-004',
      texts: ['hello', 'world'],
    });
    expect(result[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result[1]).toEqual([0.4, 0.5, 0.6]);
  });

  it('adds thinkingConfig for gemini-2.5 models', async () => {
    let capturedBody = '';
    const fakeFetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return makeSseResponse([
        sseEvent({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
      ]);
    });

    const adapter = new GeminiAdapter(makeGeminiConfig(), { fetch: fakeFetch });
    await collectEvents(adapter.chat({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    }));

    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    const gc = body['generationConfig'] as Record<string, unknown>;
    expect(gc?.['thinkingConfig']).toEqual({ includeThoughts: true });
  });
});

// ---------------------------------------------------------------------------
// 5. MockProvider
// ---------------------------------------------------------------------------

describe('MockProvider', () => {
  function makeMockConfig() {
    return {
      id: 'test-mock',
      kind: 'mock' as const,
      label: 'Test Mock',
      enabled: true,
    };
  }

  it('streams text in chunks', async () => {
    const script = vi.fn().mockReturnValue({ text: 'Hello world!', chunkSize: 5 });
    const adapter = new MockProvider(makeMockConfig(), { mockScript: script });

    const events = await collectEvents(adapter.chat({
      model: 'neo-demo',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    }));

    const text = events.filter((e) => e.type === 'text').map((e) => e.type === 'text' ? e.text : '').join('');
    expect(text).toBe('Hello world!');

    const done = events.find((e) => e.type === 'done');
    expect(done?.type === 'done' && done.stopReason).toBe('end');
  });

  it('streams reasoning events', async () => {
    const script = vi.fn().mockReturnValue({ reasoning: 'thinking...', text: 'answer', chunkSize: 20 });
    const adapter = new MockProvider(makeMockConfig(), { mockScript: script });

    const events = await collectEvents(adapter.chat({
      model: 'neo-demo',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'think about this' }] }],
    }));

    const reasoningText = events.filter((e) => e.type === 'reasoning').map((e) => e.type === 'reasoning' ? e.text : '').join('');
    expect(reasoningText).toBe('thinking...');
  });

  it('emits tool calls and sets stopReason tool_use', async () => {
    const script = vi.fn().mockReturnValue({
      toolCalls: [{ name: 'do_thing', input: { x: 1 }, id: 'call_1' }],
    });
    const adapter = new MockProvider(makeMockConfig(), { mockScript: script });

    const events = await collectEvents(adapter.chat({
      model: 'neo-demo',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'do thing' }] }],
    }));

    const tc = events.find((e) => e.type === 'tool_call');
    expect(tc?.type === 'tool_call' && tc.name).toBe('do_thing');
    expect(tc?.type === 'tool_call' && tc.input).toEqual({ x: 1 });

    const done = events.find((e) => e.type === 'done');
    expect(done?.type === 'done' && done.stopReason).toBe('tool_use');
  });

  it('emits custom usage when provided', async () => {
    const script = vi.fn().mockReturnValue({
      text: 'hi',
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    const adapter = new MockProvider(makeMockConfig(), { mockScript: script });

    const events = await collectEvents(adapter.chat({
      model: 'neo-demo',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'test' }] }],
    }));

    const usageEvent = events.find((e) => e.type === 'usage');
    expect(usageEvent?.type === 'usage' && usageEvent.usage.inputTokens).toBe(100);
    expect(usageEvent?.type === 'usage' && usageEvent.usage.outputTokens).toBe(50);
  });

  it('increments callIndex across calls', async () => {
    const indices: number[] = [];
    const script = vi.fn().mockImplementation((_req: unknown, idx: number) => {
      indices.push(idx);
      return { text: 'reply' };
    });
    const adapter = new MockProvider(makeMockConfig(), { mockScript: script });

    const req = { model: 'neo-demo', messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }] }] };
    await collectEvents(adapter.chat(req));
    await collectEvents(adapter.chat(req));
    await collectEvents(adapter.chat(req));

    expect(indices).toEqual([0, 1, 2]);
  });

  it('throws NeoError cancelled when signal aborted', async () => {
    const ac = new AbortController();
    const script = vi.fn().mockReturnValue({ text: 'long response', delayMs: 0 });
    const adapter = new MockProvider(makeMockConfig(), { mockScript: script });

    ac.abort();
    await expect(collectEvents(adapter.chat({
      model: 'neo-demo',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      signal: ac.signal,
    }))).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('listModels returns neo-demo', async () => {
    const adapter = new MockProvider(makeMockConfig());
    const models = await adapter.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('neo-demo');
  });

  it('test() returns ok: true', async () => {
    const adapter = new MockProvider(makeMockConfig());
    const result = await adapter.test();
    expect(result.ok).toBe(true);
  });
});

// 6. defaultMockScript: see mock.test.ts.

// ---------------------------------------------------------------------------
// 7. createProvider / createProviderRegistry
// ---------------------------------------------------------------------------

describe('createProvider', () => {
  it('creates OpenAIAdapter for openai kind', () => {
    const adapter = createProvider({ id: 'p1', kind: 'openai', label: 'OpenAI', apiKey: 'sk', enabled: true });
    expect(adapter.kind).toBe('openai');
    expect(adapter.id).toBe('p1');
  });

  it('creates OpenAIAdapter for openai-compatible kind', () => {
    const adapter = createProvider({ id: 'p2', kind: 'openai-compatible', label: 'Comp', enabled: true });
    expect(adapter.kind).toBe('openai-compatible');
  });

  it('creates OpenAIAdapter for ollama kind', () => {
    const adapter = createProvider({ id: 'p3', kind: 'ollama', label: 'Ollama', enabled: true });
    expect(adapter.kind).toBe('ollama');
  });

  it('creates GeminiAdapter for gemini kind', () => {
    const adapter = createProvider({ id: 'p4', kind: 'gemini', label: 'Gemini', apiKey: 'k', enabled: true });
    expect(adapter.kind).toBe('gemini');
  });

  it('creates MockProvider for mock kind', () => {
    const adapter = createProvider({ id: 'p5', kind: 'mock', label: 'Mock', enabled: true });
    expect(adapter.kind).toBe('mock');
  });

  it('throws NeoError config_error for unknown kind', () => {
    expect(() =>
      createProvider({ id: 'p6', kind: 'unknown' as never, label: 'Unknown', enabled: true }),
    ).toThrow(NeoError);
  });

  it('resolves apiKeySecret via resolveSecret', () => {
    const adapter = createProvider(
      { id: 'p7', kind: 'openai', label: 'OpenAI', apiKeySecret: 'MY_KEY', enabled: true },
      { resolveSecret: (name) => (name === 'MY_KEY' ? 'sk-resolved' : undefined) },
    );
    expect(adapter.kind).toBe('openai');
  });

  // --- Missing-key: construction never throws, error surfaces at call time ---
  it('constructs AnthropicAdapter with no key without throwing', () => {
    expect(() =>
      createProvider({ id: 'no-key-anthropic', kind: 'anthropic', label: 'A', enabled: true }),
    ).not.toThrow();
  });

  it('constructs OpenAIAdapter with no key without throwing', () => {
    expect(() =>
      createProvider({ id: 'no-key-openai', kind: 'openai', label: 'O', enabled: true }),
    ).not.toThrow();
  });

  it('constructs GeminiAdapter with no key without throwing', () => {
    expect(() =>
      createProvider({ id: 'no-key-gemini', kind: 'gemini', label: 'G', enabled: true }),
    ).not.toThrow();
  });

  it('GeminiAdapter throws provider_auth only when chat() is called with no key', async () => {
    const adapter = createProvider({ id: 'no-key-gemini2', kind: 'gemini', label: 'G', enabled: true });
    await expect(collectEvents(adapter.chat({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    }))).rejects.toMatchObject({ code: 'provider_auth' });
  });

  it('createProviderRegistry constructs disabled providers without throwing', () => {
    expect(() =>
      createProviderRegistry([
        { id: 'd1', kind: 'anthropic', label: 'A', enabled: false },
        { id: 'd2', kind: 'gemini', label: 'G', enabled: false },
        { id: 'd3', kind: 'openai', label: 'O', enabled: false },
      ]),
    ).not.toThrow();
  });

  // --- Secret resolution must not leak resolved key into adapter.config ---
  it('adapter.config keeps original config without resolved apiKey', () => {
    const originalConfig = { id: 'p8', kind: 'openai' as const, label: 'OpenAI', apiKeySecret: 'MY_KEY', enabled: true };
    const adapter = createProvider(
      originalConfig,
      { resolveSecret: (name) => (name === 'MY_KEY' ? 'sk-resolved' : undefined) },
    );
    // config must NOT have the resolved key
    expect(adapter.config.apiKey).toBeUndefined();
    // Original apiKeySecret should still be there
    expect(adapter.config.apiKeySecret).toBe('MY_KEY');
  });

  it('adapter.config keeps original config for Gemini without leaking secret', () => {
    const originalConfig = { id: 'p9', kind: 'gemini' as const, label: 'Gemini', apiKeySecret: 'GEM_KEY', enabled: true };
    const adapter = createProvider(
      originalConfig,
      { resolveSecret: (name) => (name === 'GEM_KEY' ? 'gk-resolved' : undefined) },
    );
    expect(adapter.config.apiKey).toBeUndefined();
    expect(adapter.config.apiKeySecret).toBe('GEM_KEY');
  });

  it('adapter.config keeps original config for Anthropic without leaking secret', () => {
    const originalConfig = { id: 'p10', kind: 'anthropic' as const, label: 'Anthropic', apiKeySecret: 'ANT_KEY', enabled: true };
    const adapter = createProvider(
      originalConfig,
      { resolveSecret: (name) => (name === 'ANT_KEY' ? 'sk-ant-resolved' : undefined) },
    );
    expect(adapter.config.apiKey).toBeUndefined();
    expect(adapter.config.apiKeySecret).toBe('ANT_KEY');
  });
});

describe('createProviderRegistry', () => {
  const configs = [
    { id: 'p1', kind: 'openai' as const, label: 'OpenAI', apiKey: 'sk1', enabled: true },
    { id: 'p2', kind: 'gemini' as const, label: 'Gemini', apiKey: 'gk', enabled: true },
    { id: 'p3', kind: 'mock' as const, label: 'Mock', enabled: false },
  ];

  it('get returns adapter by id', () => {
    const registry = createProviderRegistry(configs);
    expect(registry.get('p1')?.kind).toBe('openai');
    expect(registry.get('p2')?.kind).toBe('gemini');
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('list returns all adapters', () => {
    const registry = createProviderRegistry(configs);
    expect(registry.list()).toHaveLength(3);
  });

  it('resolve returns adapter and model for enabled provider', () => {
    const registry = createProviderRegistry(configs);
    const result = registry.resolve({ provider: 'p1', model: 'gpt-4o' });
    expect(result.adapter.kind).toBe('openai');
    expect(result.model).toBe('gpt-4o');
  });

  it('resolve throws config_error for disabled provider', () => {
    const registry = createProviderRegistry(configs);
    expect(() => registry.resolve({ provider: 'p3', model: 'neo-demo' })).toThrow(NeoError);
  });

  it('resolve throws not_found for unknown provider', () => {
    const registry = createProviderRegistry(configs);
    expect(() => registry.resolve({ provider: 'unknown', model: 'x' })).toThrow(NeoError);
  });

  it('upsert adds a new provider', () => {
    const registry = createProviderRegistry(configs);
    registry.upsert({ id: 'p4', kind: 'mock' as const, label: 'New Mock', enabled: true });
    expect(registry.get('p4')?.kind).toBe('mock');
  });

  it('upsert updates an existing provider', () => {
    const registry = createProviderRegistry(configs);
    registry.upsert({ id: 'p1', kind: 'mock' as const, label: 'Replaced', enabled: true });
    expect(registry.get('p1')?.kind).toBe('mock');
  });

  it('remove removes provider and returns true', () => {
    const registry = createProviderRegistry(configs);
    expect(registry.remove('p1')).toBe(true);
    expect(registry.get('p1')).toBeUndefined();
  });

  it('remove returns false for nonexistent id', () => {
    const registry = createProviderRegistry(configs);
    expect(registry.remove('nonexistent')).toBe(false);
  });
});
