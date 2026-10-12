import { describe, expect, it } from 'vitest';
import type { ChatRequest, ProviderConfig } from '@neo/protocol';
import { collectChat } from '@neo/protocol';
import { OpenAIAdapter } from './openai.js';
import {
  collect,
  dataFrames,
  fakeFetch,
  jsonResponse,
  ofType,
  recordingSleep,
  sseResponse,
  textOfEvents,
  type FakeResponder,
} from './testing/http.js';

const KEY = 'sk-proj-test-abcdefghijklmnop';

function cfg(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: 'openai', kind: 'openai', apiKey: KEY, enabled: true, ...over };
}

const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, extra: Record<string, unknown> = {}) => ({
  id: 'c1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason }],
  ...extra,
});

function stream(...events: unknown[]): FakeResponder {
  return () => sseResponse(dataFrames([...events, '[DONE]']));
}
const okReply = stream(chunk({ role: 'assistant', content: 'Hi' }), chunk({}, 'stop'));

function req(over: Partial<ChatRequest> = {}): ChatRequest {
  return { model: 'gpt-4o', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }], ...over };
}

function make(responders: FakeResponder | FakeResponder[], over: Partial<ProviderConfig> = {}) {
  const f = fakeFetch(responders);
  const sleep = recordingSleep();
  const a = new OpenAIAdapter(cfg(over), { fetch: f, sleep });
  return { a, f, sleep };
}

const TOOLS = [{ name: 'get_weather', description: 'Weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }];

describe('OpenAI request shape', () => {
  it('openai: stream_options, max_completion_tokens, temperature, auth header', async () => {
    const { a, f } = make(okReply);
    await collect(a.chat(req({ maxTokens: 500, temperature: 0.4, system: 'sys' })));
    const { body, headers, url } = f.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(body).toMatchObject({ model: 'gpt-4o', stream: true, stream_options: { include_usage: true }, max_completion_tokens: 500, temperature: 0.4 });
    expect(body).not.toHaveProperty('max_tokens');
    expect((body!['messages'] as unknown[])[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('openai-compatible: max_tokens, no stream_options, no key needed, default base URL from the preset', async () => {
    const { a, f } = make(okReply, { kind: 'openai-compatible', id: 'lm', apiKey: undefined });
    await collect(a.chat(req({ maxTokens: 500 })));
    const { body, headers, url } = f.calls[0]!;
    expect(url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(headers.get('authorization')).toBeNull();
    expect(body!['max_tokens']).toBe(500);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('stream_options');
    expect(a.isLocal).toBe(true);
  });

  it('reasoning models get reasoning_effort and no temperature (also behind a vendor prefix)', async () => {
    const { a, f } = make([okReply, okReply]);
    await collect(a.chat(req({ model: 'o3-mini', temperature: 0.7, reasoning: 'off' })));
    expect(f.calls[0]!.body).not.toHaveProperty('temperature');
    expect(f.calls[0]!.body!['reasoning_effort']).toBe('low');
    const compat = new OpenAIAdapter(cfg({ kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' }), { fetch: f });
    await collect(compat.chat(req({ model: 'openai/gpt-5', temperature: 0.7, reasoning: 'high' })));
    expect(f.calls[1]!.body).not.toHaveProperty('temperature');
    expect(f.calls[1]!.body!['reasoning_effort']).toBe('high');
  });

  it('never sends tool_choice without tools; sends none/auto with tools', async () => {
    const { a, f } = make([okReply, okReply]);
    await collect(a.chat(req({ toolChoice: 'none' })));
    expect(f.calls[0]!.body).not.toHaveProperty('tool_choice');
    expect(f.calls[0]!.body).not.toHaveProperty('tools');
    await collect(a.chat(req({ toolChoice: 'none', tools: TOOLS })));
    expect(f.calls[1]!.body!['tool_choice']).toBe('none');
    expect(f.calls[1]!.body!['tools']).toEqual([{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: TOOLS[0]!.inputSchema } }]);
  });

  it('json mode: response_format for openai/ollama plus the system instruction everywhere', async () => {
    const { a, f } = make([okReply, okReply]);
    await collect(a.chat(req({ responseFormat: 'json', system: 'Extract.' })));
    expect(f.calls[0]!.body!['response_format']).toEqual({ type: 'json_object' });
    expect((f.calls[0]!.body!['messages'] as { content: string }[])[0]!.content).toBe('Extract.\n\nRespond with a single JSON object only.');
    const compat = new OpenAIAdapter(cfg({ kind: 'openai-compatible' }), { fetch: f });
    await collect(compat.chat(req({ responseFormat: 'json' })));
    expect(f.calls[1]!.body).not.toHaveProperty('response_format');
    expect((f.calls[1]!.body!['messages'] as { role: string; content: string }[])[0]).toEqual({ role: 'system', content: 'Respond with a single JSON object only.' });
  });

  it('maps messages: text-only user as string, images as data URLs, assistant tool_calls, tool results', async () => {
    const { a, f } = make(okReply);
    await collect(
      a.chat(
        req({
          tools: TOOLS,
          messages: [
            { role: 'user', parts: [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', data: 'AAA=' }, { type: 'image', mediaType: 'image/jpeg', url: 'https://x.test/a.jpg' }] },
            { role: 'assistant', parts: [{ type: 'reasoning', text: 'hidden' }] },
            {
              role: 'assistant',
              parts: [
                { type: 'reasoning', text: 'hmm' },
                { type: 'text', text: 'Checking' },
                { type: 'tool_call', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
                { type: 'tool_call', id: 'call_2', name: 'get_weather', input: undefined },
              ],
            },
            {
              role: 'tool',
              parts: [
                { type: 'tool_result', toolCallId: 'call_1', name: 'get_weather', output: { tempC: 20 } },
                { type: 'tool_result', toolCallId: 'call_2', name: 'get_weather', output: 'oops', isError: true },
              ],
            },
            { role: 'user', parts: [{ type: 'text', text: 'thanks' }] },
          ],
        }),
      ),
    );
    expect(f.calls[0]!.body!['messages']).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } },
          { type: 'image_url', image_url: { url: 'https://x.test/a.jpg' } },
        ],
      },
      {
        role: 'assistant',
        content: 'Checking',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
          { id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":20}' },
      { role: 'tool', tool_call_id: 'call_2', content: 'oops' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('openai needs a key: provider_auth at call time, without a network call; an Authorization header counts as a key', async () => {
    const { a, f } = make(okReply, { apiKey: undefined });
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_auth' });
    await expect(a.listModels()).rejects.toMatchObject({ code: 'provider_auth' });
    await expect(a.embed({ model: 'text-embedding-3-small', texts: ['x'] })).rejects.toMatchObject({ code: 'provider_auth' });
    expect(f.calls).toHaveLength(0);
    const viaHeader = new OpenAIAdapter(cfg({ apiKey: undefined, headers: { Authorization: 'Bearer from-header' } }), { fetch: f });
    await collect(viaHeader.chat(req()));
    expect(f.calls[0]!.headers.get('authorization')).toBe('Bearer from-header');
  });

  it('resolves apiKeySecret at call time', async () => {
    let secret: string | undefined;
    const f = fakeFetch(okReply);
    const a = new OpenAIAdapter(cfg({ apiKey: undefined, apiKeySecret: 's' }), { fetch: f, resolveSecret: () => secret });
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_auth' });
    secret = 'sk-later-123456';
    await collect(a.chat(req()));
    expect(f.calls[0]!.headers.get('authorization')).toBe('Bearer sk-later-123456');
  });
});

describe('OpenAI streaming', () => {
  it('accumulates tool-call arguments by index (id/name only in the first chunk), interleaved calls', async () => {
    const { a } = make(
      stream(
        chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{"tz"' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: ':"UTC"}' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
        chunk({}, 'tool_calls'),
      ),
    );
    const events = await collect(a.chat(req({ tools: TOOLS })));
    expect(ofType(events, 'tool_call').map(({ id, name, input }) => ({ id, name, input }))).toEqual([
      { id: 'call_a', name: 'get_weather', input: { city: 'Paris' } },
      { id: 'call_b', name: 'get_time', input: { tz: 'UTC' } },
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('handles servers that omit the tool-call index and ids, and flags invalid JSON', async () => {
    const { a } = make(
      stream(
        chunk({ tool_calls: [{ id: 'call_x', function: { name: 'one', arguments: '{"a":1}' } }] }),
        chunk({ tool_calls: [{ id: 'call_y', function: { name: 'two', arguments: '{"b":' } }] }),
        chunk({ tool_calls: [{ function: { name: 'three', arguments: '{}' } }] }),
        chunk({}, 'stop'),
      ),
    );
    const calls = ofType(await collect(a.chat(req({ tools: TOOLS }))), 'tool_call');
    expect(calls.map((c) => [c.name, c.input])).toEqual([
      ['one', { a: 1 }],
      ['two', { __invalid_json: '{"b":' }],
      ['three', {}],
    ]);
    expect(calls[2]!.id).toMatch(/^call_/);
    expect(new Set(calls.map((c) => c.id)).size).toBe(3);
  });

  it('emits reasoning from reasoning_content and reasoning deltas', async () => {
    const { a } = make(stream(chunk({ reasoning_content: 'think ' }), chunk({ reasoning: 'more' }), chunk({ content: 'answer' }), chunk({}, 'stop')));
    const events = await collect(a.chat(req()));
    expect(ofType(events, 'reasoning').map((e) => e.text).join('')).toBe('think more');
    expect(textOfEvents(events)).toBe('answer');
  });

  it('emits exactly one usage event (the last report), with cached tokens split out, before done', async () => {
    const { a } = make(
      stream(
        chunk({ content: 'a' }, null, { usage: { prompt_tokens: 5, completion_tokens: 1 } }),
        chunk({ content: 'b' }, null, { usage: { prompt_tokens: 5, completion_tokens: 2 } }),
        chunk({}, 'stop'),
        { id: 'c1', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 4 } } },
      ),
    );
    const events = await collect(a.chat(req()));
    const usage = ofType(events, 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage).toEqual({ inputTokens: 40, outputTokens: 20, cacheReadTokens: 60, reasoningTokens: 4 });
    expect(events.at(-2)!.type).toBe('usage');
    expect(ofType(events, 'done')).toHaveLength(1);
    expect((await collectChat(make(okReply).a.chat(req()))).text).toBe('Hi');
  });

  it('a structured refusal delta is shown and reported as refusal', async () => {
    const { a } = make(stream(chunk({ refusal: "I'm sorry, " }), chunk({ refusal: 'I cannot help with that.' }), chunk({}, 'stop')));
    const events = await collect(a.chat(req()));
    expect(textOfEvents(events)).toBe("I'm sorry, I cannot help with that.");
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'refusal' });
  });

  it.each([
    ['stop', 'end'],
    ['length', 'max_tokens'],
    ['content_filter', 'refusal'],
  ] as const)('maps finish_reason %s → %s', async (finish, expected) => {
    const { a } = make(stream(chunk({ content: 'x' }), chunk({}, finish)));
    expect((await collect(a.chat(req()))).at(-1)).toEqual({ type: 'done', stopReason: expected });
  });

  it('a truncated tool call (finish_reason length) reports max_tokens', async () => {
    const { a } = make(stream(chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'get_weather', arguments: '{"ci' } }] }), chunk({}, 'length')));
    expect((await collect(a.chat(req({ tools: TOOLS })))).at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
  });

  it('Ollama-style finish_reason "stop" with tool calls reports tool_use', async () => {
    const { a } = make(stream(chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'get_weather', arguments: '{}' } }] }), chunk({}, 'stop')));
    expect((await collect(a.chat(req({ tools: TOOLS })))).at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('a stream that ends before finishing is an error', async () => {
    const { a } = make(() => sseResponse(dataFrames([chunk({ content: 'cut' })])));
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_error', retryable: true });
  });

  it('an error object inside the stream is surfaced', async () => {
    const { a } = make(() => sseResponse(dataFrames([chunk({ content: 'x' }), { error: { message: 'upstream exploded', code: 502 } }])));
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_error', message: expect.stringContaining('upstream exploded') });
  });

  it('abort mid-stream ends with cancelled', async () => {
    const ac = new AbortController();
    const { a } = make((r) => sseResponse(dataFrames([chunk({ content: 'Hi' })]), { hang: true, signal: r.signal }));
    const it = a.chat(req({ signal: ac.signal }))[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ type: 'text', text: 'Hi' });
    ac.abort();
    await expect(it.next()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('abort stops the stream even when the body ignores the signal', async () => {
    const ac = new AbortController();
    const { a } = make(() => sseResponse(dataFrames([chunk({ content: 'Hi' })]), { hang: true }));
    const it = a.chat(req({ signal: ac.signal }))[Symbol.asyncIterator]();
    await it.next();
    setTimeout(() => ac.abort(), 5);
    await expect(it.next()).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('OpenAI errors and retries', () => {
  const err = (status: number, message: string, headers: Record<string, string> = {}): FakeResponder => () =>
    jsonResponse({ error: { message, type: 'x' } }, status, headers);

  it('retries 429 (honoring retry-after) and 5xx, then succeeds', async () => {
    const { a, f, sleep } = make([err(429, 'slow', { 'retry-after': '1' }), err(503, 'busy'), okReply]);
    expect(textOfEvents(await collect(a.chat(req())))).toBe('Hi');
    expect(f.calls).toHaveLength(3);
    expect(sleep.delays).toEqual([1000, 1500]);
  });

  it('never retries 400 and surfaces the provider message', async () => {
    const { a, f } = make([err(400, 'Invalid model'), okReply]);
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_error', message: expect.stringContaining('Invalid model') });
    expect(f.calls).toHaveLength(1);
  });

  it('429 with a long retry-after is not waited out; rate_limited carries retryAfterMs', async () => {
    const { a, f, sleep } = make([err(429, 'slow', { 'retry-after': '30' }), okReply]);
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'rate_limited', retryable: true, details: { retryAfterMs: 30_000 } });
    expect(f.calls).toHaveLength(1);
    expect(sleep.delays).toEqual([]);
  });

  it('401 → provider_auth with the key redacted', async () => {
    const { a } = make(err(401, `Incorrect API key provided: ${KEY}`));
    const e = (await collect(a.chat(req())).catch((x: unknown) => x)) as Error & { code: string };
    expect(e.code).toBe('provider_auth');
    expect(e.message).not.toContain(KEY);
  });

  it('network failures name the host and are retryable', async () => {
    const f = fakeFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 10.0.0.5:443') });
    });
    const a = new OpenAIAdapter(cfg({ kind: 'openai-compatible', baseUrl: 'http://10.0.0.5/v1' }), { fetch: f, sleep: recordingSleep() });
    await expect(collect(a.chat(req()))).rejects.toMatchObject({
      code: 'provider_error',
      retryable: true,
      message: expect.stringContaining('10.0.0.5'),
    });
    expect(f.calls).toHaveLength(3);
  });
});

describe('Ollama', () => {
  const ollama = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: 'ollama', kind: 'ollama', enabled: true, ...over });

  it('chat on <base>/v1, tags and embed on the root, also when the base URL already ends in /v1', async () => {
    for (const baseUrl of ['http://127.0.0.1:11434', 'http://127.0.0.1:11434/', 'http://127.0.0.1:11434/v1']) {
      const f = fakeFetch((r) =>
        r.url.endsWith('/api/tags')
          ? jsonResponse({ models: [{ name: 'llava:7b' }, { name: 'qwen2.5:14b' }] })
          : r.url.endsWith('/api/embed')
            ? jsonResponse({ embeddings: [[0.1, 0.2]] })
            : okReply(r, 0),
      );
      const a = new OpenAIAdapter(ollama({ baseUrl }), { fetch: f });
      await collect(a.chat(req({ model: 'llama3.1', responseFormat: 'json' })));
      const models = await a.listModels();
      await a.embed({ model: 'nomic-embed-text', texts: ['x'] });
      expect(f.calls.map((c) => c.url)).toEqual([
        'http://127.0.0.1:11434/v1/chat/completions',
        'http://127.0.0.1:11434/api/tags',
        'http://127.0.0.1:11434/api/embed',
      ]);
      expect(f.calls[0]!.body!['response_format']).toEqual({ type: 'json_object' });
      expect(f.calls[2]!.body).toEqual({ model: 'nomic-embed-text', input: ['x'] });
      expect(models.map((m) => [m.id, m.capabilities.vision, m.capabilities.contextWindow])).toEqual([
        ['llava:7b', true, 32_000],
        ['qwen2.5:14b', false, 128_000],
      ]);
    }
  });

  it('is local by default and gives a helpful hint when not running', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const a = new OpenAIAdapter(ollama({ baseUrl: 'http://192.0.2.1:11434' }), { fetch: f, sleep: recordingSleep() });
    expect(a.isLocal).toBe(true);
    await expect(collect(a.chat(req({ model: 'llama3.1' })))).rejects.toMatchObject({ message: expect.stringContaining('ollama serve') });
    await expect(a.listModels()).rejects.toMatchObject({ message: expect.stringContaining('ollama serve') });
    const test = await a.test();
    expect(test.ok).toBe(false);
    expect(test.error).toContain('ollama serve');
  });
});

describe('OpenAI listModels and embed', () => {
  it('does not expose malformed model-response text in errors or connection tests', async () => {
    const { a } = make(() => new Response(KEY, { headers: { 'Content-Type': 'application/json' } }));
    const error = await a.listModels().catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'provider_error', message: 'OpenAI returned invalid model data.' });
    expect(error).not.toHaveProperty('cause');
    expect(await a.test()).toMatchObject({ ok: false, error: 'OpenAI returned invalid model data.' });
  });

  it.each([null, { data: null }, { data: KEY }])('rejects malformed model-list structures safely: %j', async (body) => {
    const { a } = make(() => jsonResponse(body));
    await expect(a.listModels()).rejects.toMatchObject({ code: 'provider_error', message: 'OpenAI returned invalid model data.' });
  });

  it('ignores invalid entries and redacts echoed credentials in labels', async () => {
    const { a } = make(() => jsonResponse({ data: [null, 42, KEY, { id: {} }, { id: 'gpt-5', name: `Model ${KEY}` }] }));
    const models = await a.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'gpt-5', label: 'Model [redacted]' });
    expect(JSON.stringify(models)).not.toContain(KEY);
  });

  it('rejects credential echoes in model ids instead of returning them', async () => {
    const { a } = make(() => jsonResponse({ data: [{ id: KEY }] }));
    await expect(a.listModels()).rejects.toMatchObject({ code: 'provider_error', message: 'OpenAI returned invalid model data.' });
  });

  it('validates and redacts Ollama model listings too', async () => {
    const { a } = make(() => new Response(KEY, { headers: { 'Content-Type': 'application/json' } }), { kind: 'ollama' });
    await expect(a.listModels()).rejects.toMatchObject({ code: 'provider_error', message: 'Ollama returned invalid model data.' });
  });

  it('distinguishes dedicated capability models from chat models in the listing', async () => {
    const ids = ['gpt-5', 'text-embedding-3-small', 'whisper-1', 'gpt-4o-mini-transcribe', 'tts-1', 'gpt-4o-mini-tts', 'dall-e-3', 'gpt-image-1', 'sora-2', 'gpt-4o-realtime-preview', 'gpt-audio', 'omni-moderation-latest'];
    const { a } = make(() => jsonResponse({ data: ids.map((id) => ({ id })) }));
    const models = await a.listModels();
    expect(models.filter((m) => m.capabilities.text).map((m) => m.id)).toEqual(['gpt-5']);
    expect(models.filter((m) => m.capabilities.embeddings).map((m) => m.id)).toEqual(['text-embedding-3-small']);
    expect(models.filter((m) => m.capabilities.speechToText).map((m) => m.id)).toEqual(['whisper-1', 'gpt-4o-mini-transcribe']);
    expect(models.filter((m) => m.capabilities.textToSpeech).map((m) => m.id)).toEqual(['tts-1', 'gpt-4o-mini-tts']);
    expect(models.filter((m) => m.capabilities.image).map((m) => m.id)).toEqual(['dall-e-3', 'gpt-image-1']);
    expect(models.filter((m) => m.capabilities.video).map((m) => m.id)).toEqual(['sora-2']);
    expect(models.filter((m) => !m.capabilities.text).every((m) => !m.capabilities.tools && !m.capabilities.vision && !m.capabilities.reasoning)).toBe(true);
  });

  it('uses OpenRouter modality metadata without treating image or audio input as generation support', async () => {
    const { a, f } = make(() => jsonResponse({ data: [
      { id: 'vendor/general', name: 'General', architecture: { input_modalities: ['text', 'image', 'audio'], output_modalities: ['text'] }, supported_parameters: ['tools', 'reasoning'], context_length: 256_000, top_provider: { max_completion_tokens: 32_000 } },
      { id: 'vendor/image', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] }, supported_parameters: [] },
      { id: 'vendor/speech', architecture: { input_modalities: ['text'], output_modalities: ['audio'] } },
      { id: 'vendor/video', architecture: { input_modalities: ['text'], output_modalities: ['video'] } },
      { id: 'vendor/vector', architecture: { input_modalities: ['text'], output_modalities: ['embedding'] } },
    ] }), { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' });
    const models = await a.listModels();
    expect(f.calls[0]!.url).toBe('https://openrouter.ai/api/v1/models');
    expect(models[0]).toMatchObject({ label: 'General', capabilities: { text: true, tools: true, vision: true, reasoning: true, speechToText: true, textToSpeech: false, image: false, video: false, contextWindow: 256_000, maxOutputTokens: 32_000 } });
    expect(models[1]!.capabilities).toMatchObject({ text: false, tools: false, vision: false, image: true, speechToText: false });
    expect(models[2]!.capabilities).toMatchObject({ text: false, textToSpeech: true, speechToText: false });
    expect(models[3]!.capabilities).toMatchObject({ text: false, video: true });
    expect(models[4]!.capabilities).toMatchObject({ text: false, embeddings: true });
    expect(a.capabilities('vendor/image')).toEqual(models[1]!.capabilities);
  });

  it('preserves custom chat-model fallback and refreshes listing metadata', async () => {
    const { a } = make([
      () => jsonResponse({ data: [{ id: 'local-model', architecture: { input_modalities: ['text'], output_modalities: ['image'] } }] }),
      () => jsonResponse({ data: [{ id: 'local-model' }] }),
    ], { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: undefined });
    expect((await a.listModels())[0]!.capabilities.text).toBe(false);
    expect((await a.listModels())[0]!.capabilities).toMatchObject({ text: true, tools: true, image: false });
  });

  it('lists models with the key', async () => {
    const { a, f } = make(() => jsonResponse({ data: [{ id: 'gpt-5' }, { id: 'text-embedding-3-small' }] }));
    const models = await a.listModels();
    expect(f.calls[0]!.url).toBe('https://api.openai.com/v1/models');
    expect(f.calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(models.map((m) => [m.id, m.capabilities.reasoning, m.capabilities.embeddings])).toEqual([
      ['gpt-5', true, false],
      ['text-embedding-3-small', false, true],
    ]);
  });

  it('embed returns vectors in input order', async () => {
    const { a, f } = make(() => jsonResponse({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }));
    expect(await a.embed({ model: 'text-embedding-3-small', texts: ['a', 'b'] })).toEqual([[1], [2]]);
    expect(f.calls[0]!.body).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'] });
  });

  it('embed rejects a response with the wrong number of vectors', async () => {
    const { a } = make(() => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));
    await expect(a.embed({ model: 'm', texts: ['a', 'b'] })).rejects.toMatchObject({ code: 'provider_error' });
  });
});
