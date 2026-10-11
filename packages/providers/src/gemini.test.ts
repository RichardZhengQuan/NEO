import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatRequest, ProviderConfig } from '@neo/protocol';
import { GeminiAdapter, sanitizeGeminiSchema } from './gemini.js';
import { collect, dataFrames, fakeFetch, jsonResponse, ofType, recordingSleep, sseResponse, textOfEvents, type FakeResponder } from './testing/http.js';

const KEY = 'AIzaSyTEST-0123456789abcdef';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

function cfg(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: 'gemini', kind: 'gemini', apiKey: KEY, enabled: true, ...over };
}

const cand = (parts: unknown[], finishReason?: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
  ...extra,
});
const stream = (...events: unknown[]): FakeResponder => () => sseResponse(dataFrames(events));
const okReply = stream(cand([{ text: 'Hi' }], 'STOP'));

function make(responders: FakeResponder | FakeResponder[], over: Partial<ProviderConfig> = {}) {
  const f = fakeFetch(responders);
  const sleep = recordingSleep();
  return { a: new GeminiAdapter(cfg(over), { fetch: f, sleep }), f, sleep };
}

function req(over: Partial<ChatRequest> = {}): ChatRequest {
  return { model: 'gemini-2.5-flash', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }], ...over };
}

const TOOLS = [{ name: 'get_weather', description: 'Weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];

describe('Gemini request', () => {
  it('sends the key in x-goog-api-key (never in the URL) and maps the request', async () => {
    const { a, f } = make(okReply);
    await collect(a.chat(req({ system: 'sys', maxTokens: 100, temperature: 0.3, tools: TOOLS, toolChoice: 'none' })));
    const call = f.calls[0]!;
    expect(call.url).toBe(`${BASE}/models/gemini-2.5-flash:streamGenerateContent?alt=sse`);
    expect(call.url).not.toContain(KEY);
    expect(call.headers.get('x-goog-api-key')).toBe(KEY);
    expect(call.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { maxOutputTokens: 100, temperature: 0.3, thinkingConfig: { includeThoughts: true } },
      tools: [{ functionDeclarations: [{ name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }] }],
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
    });
  });

  it('enables thought summaries for 2.5+ models only', async () => {
    const { a, f } = make([okReply, okReply, okReply]);
    await collect(a.chat(req({ model: 'gemini-3-pro-preview' })));
    await collect(a.chat(req({ model: 'gemini-2.0-flash' })));
    await collect(a.chat(req({ model: 'models/gemini-2.5-pro', responseFormat: 'json' })));
    expect((f.calls[0]!.body!['generationConfig'] as Record<string, unknown>)['thinkingConfig']).toEqual({ includeThoughts: true });
    expect(f.calls[1]!.body!['generationConfig']).toBeUndefined();
    expect(f.calls[2]!.url).toContain('/models/gemini-2.5-pro:streamGenerateContent');
    expect((f.calls[2]!.body!['generationConfig'] as Record<string, unknown>)['responseMimeType']).toBe('application/json');
  });

  it('pairs functionResponse with the function name and replays thought signatures only for the same model', async () => {
    const { a, f } = make([okReply, okReply]);
    const history: ChatMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'weather?' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'I should call the tool', provider: 'gemini', model: 'gemini-2.5-flash', data: { thoughtSignature: 'sig-thought' } },
          { type: 'reasoning', text: 'claude thinking', provider: 'anthropic', model: 'claude-opus-5-5', data: { type: 'thinking', signature: 's' } },
          { type: 'reasoning', text: 'placeholder without data', provider: 'gemini', model: 'gemini-2.5-flash' },
          { type: 'tool_call', id: 'call_1', name: 'get_weather', input: { city: 'Paris' }, provider: 'gemini', data: { thoughtSignature: 'sig-call', model: 'gemini-2.5-flash' } },
        ],
      },
      { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'call_1', name: 'get_weather', output: { tempC: 20 } }] },
    ];
    await collect(a.chat(req({ messages: history, tools: TOOLS })));
    const contents = f.calls[0]!.body!['contents'] as { role: string; parts: Record<string, unknown>[] }[];
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'I should call the tool', thought: true, thoughtSignature: 'sig-thought' },
        { functionCall: { name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-call' },
      ],
    });
    expect(contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { result: { tempC: 20 } } } }] });

    // A different model: no reasoning, no signatures.
    await collect(a.chat(req({ model: 'gemini-2.5-pro', messages: history, tools: TOOLS })));
    const contents2 = f.calls[1]!.body!['contents'] as { parts: Record<string, unknown>[] }[];
    expect(contents2[1]!.parts).toEqual([{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }]);
  });

  it('maps inline images and keeps URL images as a readable note', async () => {
    const { a, f } = make(okReply);
    await collect(
      a.chat(
        req({
          messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/png', data: 'AAA=' }, { type: 'image', mediaType: 'image/png', url: 'https://x.test/a.png' }, { type: 'text', text: 'what?' }] }],
        }),
      ),
    );
    const parts = (f.calls[0]!.body!['contents'] as { parts: unknown[] }[])[0]!.parts;
    expect(parts[0]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AAA=' } });
    expect(JSON.stringify(parts[1])).toContain('https://x.test/a.png');
    expect(parts[2]).toEqual({ text: 'what?' });
  });

  it('omits parameters for tools without properties', async () => {
    const { a, f } = make(okReply);
    await collect(a.chat(req({ tools: [{ name: 'now', description: 'time', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] })));
    const decl = ((f.calls[0]!.body!['tools'] as { functionDeclarations: Record<string, unknown>[] }[])[0]!.functionDeclarations)[0]!;
    expect(decl).toEqual({ name: 'now', description: 'time' });
  });
});

describe('sanitizeGeminiSchema', () => {
  it('drops $schema/additionalProperties, inlines $ref/$defs, const → enum, nullable unions', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      $defs: { Item: { type: 'object', properties: { name: { type: 'string', const: 'x' } }, required: ['name'], additionalProperties: false } },
      properties: {
        item: { $ref: '#/$defs/Item' },
        items: { type: 'array', items: { $ref: '#/$defs/Item' } },
        maybe: { anyOf: [{ type: 'string', description: 'm' }, { type: 'null' }] },
        maybe2: { type: ['integer', 'null'] },
        url: { type: 'string', format: 'uri' },
        when: { type: 'string', format: 'date-time' },
        level: { type: 'number', const: 3 },
      },
      required: ['item'],
    };
    expect(sanitizeGeminiSchema(schema)).toEqual({
      type: 'object',
      properties: {
        item: { type: 'object', properties: { name: { type: 'string', enum: ['x'] } }, required: ['name'] },
        items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string', enum: ['x'] } }, required: ['name'] } },
        maybe: { type: 'string', description: 'm', nullable: true },
        maybe2: { type: 'integer', nullable: true },
        url: { type: 'string' },
        when: { type: 'string', format: 'date-time' },
        level: { type: 'number' },
      },
      required: ['item'],
    });
  });

  it('keeps property names that look like keywords and survives recursive refs', () => {
    const schema = {
      type: 'object',
      properties: { $ref: { type: 'string' }, format: { type: 'string' }, node: { $ref: '#/definitions/Node' } },
      definitions: { Node: { type: 'object', properties: { name: { type: 'string' }, child: { $ref: '#/definitions/Node' } } } },
    };
    const out = sanitizeGeminiSchema(schema) as { properties: Record<string, unknown> };
    expect(Object.keys(out.properties)).toEqual(['$ref', 'format', 'node']);
    expect(JSON.stringify(out)).not.toContain('"$ref":"#');
    expect(JSON.stringify(out)).not.toContain('definitions');
    expect(out.properties['node']).toEqual({
      type: 'object',
      properties: { name: { type: 'string' }, child: { type: 'object', properties: { name: { type: 'string' } } } },
    });
  });

  it('drops free-form object properties (and their required entries); arrays with free-form items get a {type:object} fallback', () => {
    const out = sanitizeGeminiSchema({
      type: 'object',
      properties: {
        url: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        // blocks mirrors render_ui's `blocks: z.array(z.record(z.string(), z.unknown()))` —
        // items is a free-form object; after sanitization it must still have items (F07 fix).
        blocks: { type: 'array', items: { type: 'object', additionalProperties: {} } },
      },
      required: ['url', 'headers'],
    });
    expect(out).toEqual({
      type: 'object',
      properties: { url: { type: 'string' }, blocks: { type: 'array', items: { type: 'object' } } },
      required: ['url'],
    });
  });

  it('arrays without any items declaration also get a {type:object} fallback', () => {
    const out = sanitizeGeminiSchema({ type: 'array' });
    expect(out).toEqual({ type: 'array', items: { type: 'object' } });
  });
});

// ── Built-in tool schema coverage ──────────────────────────────────────────────
// These schemas are the JSON Schema representations that toolInputJsonSchema()
// produces for the actual built-in tools in @neo/tools (inlined here to avoid a
// package-dep cycle between providers and tools). Every array in the sanitized
// output must have an `items` key — Gemini's OpenAPI schema contract requires it.

function collectArraysMissingItems(schema: unknown, path = ''): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const s = schema as Record<string, unknown>;
  const missing: string[] = [];
  if (s['type'] === 'array' && s['items'] === undefined) {
    missing.push(path || '(root)');
  }
  for (const [key, value] of Object.entries(s)) {
    if (key === 'items' || key === 'properties') {
      if (key === 'items') {
        missing.push(...collectArraysMissingItems(value, `${path}.items`));
      } else if (typeof value === 'object' && value !== null) {
        for (const [prop, propSchema] of Object.entries(value as Record<string, unknown>)) {
          missing.push(...collectArraysMissingItems(propSchema, `${path}.${prop}`));
        }
      }
    }
  }
  return missing;
}

// Representative inputSchema JSON for every built-in tool that carries arrays.
// Derived from the Zod definitions in packages/tools/src/builtins/*.ts after
// running z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }).
const BUILTIN_TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  // render_ui: blocks is z.array(z.record(z.string(), z.unknown())) — free-form object items.
  render_ui: {
    type: 'object',
    properties: {
      blocks: {
        type: 'array',
        items: { type: 'object', additionalProperties: {} },
        minItems: 1,
        maxItems: 20,
        description: 'UI blocks, each an object with a "type".',
      },
    },
    required: ['blocks'],
  },
  // web_fetch: headers is additionalProperties — becomes a free-form object (not an array, but kept for completeness).
  web_fetch: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      method: { type: 'string' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['url'],
  },
  // create_reminder: recurrence.byWeekday is an array of integers.
  create_reminder: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      when: { type: 'string' },
      recurrence: {
        type: 'object',
        properties: {
          freq: { type: 'string' },
          byWeekday: { type: 'array', items: { type: 'integer' } },
          byMonthDay: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
    required: ['title', 'when'],
  },
};

describe('built-in tool schemas: every array has items after sanitization (F07)', () => {
  for (const [toolName, rawSchema] of Object.entries(BUILTIN_TOOL_SCHEMAS)) {
    it(`${toolName} — no array is missing items`, () => {
      const sanitized = sanitizeGeminiSchema(rawSchema);
      const missing = collectArraysMissingItems(sanitized);
      expect(missing, `Arrays without items in ${toolName}: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

describe('Gemini streaming', () => {
  it('thought parts → reasoning; signature completes one reasoning part; text; function calls with signatures; single usage', async () => {
    const { a } = make(
      stream(
        cand([{ text: 'Thinking ', thought: true }], undefined, { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } }),
        cand([{ text: 'more.', thought: true, thoughtSignature: 'sig-t' }]),
        cand([{ text: 'Calling.' }]),
        cand([{ functionCall: { name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-fc' }, { functionCall: { name: 'get_weather', args: { city: 'Rome' } } }]),
        cand([], 'STOP', { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 4 } }),
      ),
    );
    const events = await collect(a.chat(req({ tools: TOOLS })));
    expect(ofType(events, 'reasoning').map((e) => e.text).join('')).toBe('Thinking more.');
    expect(ofType(events, 'reasoning_part').map((e) => e.part)).toEqual([
      { type: 'reasoning', text: 'Thinking more.', provider: 'gemini', model: 'gemini-2.5-flash', data: { thoughtSignature: 'sig-t' } },
    ]);
    expect(textOfEvents(events)).toBe('Calling.');
    const calls = ofType(events, 'tool_call');
    expect(calls.map((c) => [c.name, c.input, c.data])).toEqual([
      ['get_weather', { city: 'Paris' }, { thoughtSignature: 'sig-fc', model: 'gemini-2.5-flash' }],
      ['get_weather', { city: 'Rome' }, undefined],
    ]);
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
    const usage = ofType(events, 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage).toEqual({ inputTokens: 6, outputTokens: 25, cacheReadTokens: 4, reasoningTokens: 5 });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it.each([
    ['STOP', 'end'],
    ['MAX_TOKENS', 'max_tokens'],
    ['SAFETY', 'refusal'],
    ['RECITATION', 'refusal'],
    ['PROHIBITED_CONTENT', 'refusal'],
    ['BLOCKLIST', 'refusal'],
    ['SPII', 'refusal'],
  ] as const)('maps finishReason %s → %s', async (finish, expected) => {
    const { a } = make(stream(cand([{ text: 'x' }], finish)));
    expect((await collect(a.chat(req()))).at(-1)).toEqual({ type: 'done', stopReason: expected });
  });

  it('a blocked prompt is a refusal with a short note', async () => {
    const { a } = make(stream({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 3 } }));
    const events = await collect(a.chat(req()));
    expect(textOfEvents(events).length).toBeGreaterThan(0);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'refusal' });
  });

  it('a stream without a finish reason is an error; an error chunk is surfaced', async () => {
    await expect(collect(make(stream(cand([{ text: 'cut' }]))).a.chat(req()))).rejects.toMatchObject({ code: 'provider_error', retryable: true });
    await expect(collect(make(stream(cand([{ text: 'x' }]), { error: { code: 500, message: 'Internal', status: 'INTERNAL' } })).a.chat(req()))).rejects.toMatchObject({
      code: 'provider_error',
      message: expect.stringContaining('Internal'),
    });
  });

  it('abort mid-stream → cancelled', async () => {
    const ac = new AbortController();
    const { a } = make(() => sseResponse(dataFrames([cand([{ text: 'Hi' }])]), { hang: true }));
    const it = a.chat(req({ signal: ac.signal }))[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ type: 'text', text: 'Hi' });
    ac.abort();
    await expect(it.next()).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('Gemini errors, keys, models, embeddings', () => {
  const gErr = (status: number, message: string, extra: Record<string, unknown> = {}): FakeResponder => () =>
    jsonResponse({ error: { code: status, message, status: 'X', ...extra } }, status);

  it('an invalid key (HTTP 400 API_KEY_INVALID) is provider_auth', async () => {
    const { a } = make(gErr(400, 'API key not valid. Please pass a valid API key.', { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] }));
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_auth' });
  });

  it('429 retries honor RetryInfo; an over-long delay surfaces rate_limited with retryAfterMs', async () => {
    const retryInfo = (delay: string) => ({ details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] });
    const { a, f } = make([gErr(429, 'quota', retryInfo('30s')), okReply]);
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'rate_limited', details: { retryAfterMs: 30_000 } });
    expect(f.calls).toHaveLength(1);
    const { a: a2, f: f2 } = make([gErr(503, 'overloaded'), okReply]);
    expect(textOfEvents(await collect(a2.chat(req())))).toBe('Hi');
    expect(f2.calls).toHaveLength(2);
  });

  it('missing key → provider_auth without network; apiKeySecret resolved at call time', async () => {
    let secret: string | undefined;
    const f = fakeFetch(okReply);
    const a = new GeminiAdapter(cfg({ apiKey: undefined, apiKeySecret: 'g' }), { fetch: f, resolveSecret: () => secret });
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_auth' });
    expect(f.calls).toHaveLength(0);
    secret = 'AIza-later-123456';
    await collect(a.chat(req()));
    expect(f.calls[0]!.headers.get('x-goog-api-key')).toBe('AIza-later-123456');
  });

  it('the key never appears in error messages', async () => {
    const { a } = make(gErr(400, `bad request for key=${KEY}`));
    const e = (await collect(a.chat(req())).catch((x: unknown) => x)) as Error;
    expect(e.message).not.toContain(KEY);
  });

  it('listModels follows pages and keeps generateContent models', async () => {
    const { a, f } = make([
      () => jsonResponse({ models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 }], nextPageToken: 'p2' }),
      () => jsonResponse({ models: [{ name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }, { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] }] }),
    ]);
    const models = await a.listModels();
    expect(f.calls.map((c) => c.url)).toEqual([`${BASE}/models?pageSize=200`, `${BASE}/models?pageSize=200&pageToken=p2`]);
    expect(f.calls[0]!.headers.get('x-goog-api-key')).toBe(KEY);
    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
    expect(models[0]!.capabilities).toMatchObject({ contextWindow: 1_048_576, maxOutputTokens: 65_536, reasoning: true, vision: true });
  });

  it('embed uses batchEmbedContents with the key header and returns one vector per text', async () => {
    const { a, f } = make(() => jsonResponse({ embeddings: [{ values: [1, 2] }, { values: [3, 4] }] }));
    expect(await a.embed({ model: 'gemini-embedding-001', texts: ['a', 'b'] })).toEqual([[1, 2], [3, 4]]);
    expect(f.calls[0]!.url).toBe(`${BASE}/models/gemini-embedding-001:batchEmbedContents`);
    expect(f.calls[0]!.headers.get('x-goog-api-key')).toBe(KEY);
    expect(f.calls[0]!.body).toEqual({
      requests: [
        { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'a' }] } },
        { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'b' }] } },
      ],
    });
  });
});
