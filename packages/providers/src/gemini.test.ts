import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NeoError, toolInputJsonSchema, type ChatMessage, type ChatRequest, type ProviderConfig, type MemoryService, type ProductivityStores } from '@neo/protocol';
import { createBuiltinTools } from '../../tools/src/builtins/index.js';
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

  it('wraps union-root tool input schemas in an object root', async () => {
    const schema = toolInputJsonSchema(z.union([
      z.object({ kind: z.literal('a'), x: z.string() }),
      z.object({ kind: z.literal('b'), y: z.number() }),
    ]));
    const { a, f } = make(okReply);
    await collect(a.chat(req({ tools: [{ name: 'union_tool', description: 'Union input', inputSchema: schema }] })));
    const decl = ((f.calls[0]!.body!['tools'] as { functionDeclarations: Record<string, unknown>[] }[])[0]!.functionDeclarations)[0]! as Record<string, unknown>;
    expect(decl['name']).toBe('union_tool');
    const parameters = decl['parameters'] as Record<string, unknown>;
    expect(parameters['type']).toBe('object');
    expect(parameters['properties']).toHaveProperty('value');
  });

  it('preserves object-root tool input schemas', async () => {
    const schema = toolInputJsonSchema(z.object({ city: z.string() }));
    const { a, f } = make(okReply);
    await collect(a.chat(req({ tools: [{ name: 'get_weather', description: 'Weather', inputSchema: schema }] })));
    const decl = ((f.calls[0]!.body!['tools'] as { functionDeclarations: Record<string, unknown>[] }[])[0]!.functionDeclarations)[0]! as Record<string, unknown>;
    const parameters = decl['parameters'] as Record<string, unknown>;
    expect(parameters['type']).toBe('object');
    expect(parameters['properties']).not.toHaveProperty('value');
  });

  it.each([
    ['union', z.union([z.object({ kind: z.literal('a'), x: z.string() }), z.object({ kind: z.literal('b'), y: z.number() })]), { kind: 'a', x: 'hello' }],
    ['string', z.string(), 'raw-value'],
  ] as const)('unwraps {value:...} from model-emitted %s tool call inputs', async (_name, schema, actual) => {
    const inputSchema = toolInputJsonSchema(schema as z.ZodType);
    const wire = { value: actual };
    const { a } = make(stream(
      cand([{ functionCall: { name: 'plugin_tool', args: wire } }], 'STOP'),
    ));
    const events = await collect(a.chat(req({ tools: [{ name: 'plugin_tool', description: 'Plugin', inputSchema }] })));
    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall).toMatchObject({ type: 'tool_call', name: 'plugin_tool', input: actual });
  });

  it('does not unwrap {value:...} for object-root tool schemas (Gemini)', async () => {
    const inputSchema = toolInputJsonSchema(z.object({ city: z.string() }));
    const wire = { city: 'Paris' };
    const { a } = make(stream(
      cand([{ functionCall: { name: 'get_weather', args: wire } }], 'STOP'),
    ));
    const events = await collect(a.chat(req({ tools: [{ name: 'get_weather', description: 'Weather', inputSchema }] })));
    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall).toMatchObject({ type: 'tool_call', name: 'get_weather', input: { city: 'Paris' } });
  });
});

describe('sanitizeGeminiSchema', () => {
  it('merges $ref target constraints with sibling constraints', () => {
    const schema = {
      $defs: { A: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } } },
      $ref: '#/$defs/A',
      required: ['b'],
      properties: { b: { type: 'string' } },
    };
    const out = sanitizeGeminiSchema(schema);
    expect(out).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['a', 'b']),
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    });
    // Both a and b must be in required (order doesn't matter)
    expect((out as { required: string[] }).required).toHaveLength(2);
  });

  it('merges single-branch anyOf sibling constraints with branch constraints', () => {
    const schema = {
      anyOf: [{ type: 'object', required: ['a'], properties: { a: { type: 'string' } } }],
      required: ['b'],
      properties: { b: { type: 'string' } },
    };
    const out = sanitizeGeminiSchema(schema);
    expect(out).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['a', 'b']),
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    });
    expect((out as { required: string[] }).required).toHaveLength(2);
  });

  it('merges single-item allOf sibling constraints with inner constraints', () => {
    const schema = {
      allOf: [{ type: 'object', required: ['a'], properties: { a: { type: 'string' } } }],
      required: ['b'],
      properties: { b: { type: 'string' } },
    };
    const out = sanitizeGeminiSchema(schema);
    expect(out).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['a', 'b']),
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    });
    expect((out as { required: string[] }).required).toHaveLength(2);
  });

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

  it('preserves all non-null types in a type-union array', () => {
    expect(sanitizeGeminiSchema({ type: ['string', 'number'] })).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('preserves enum restriction on a mixed-type union', () => {
    const out = sanitizeGeminiSchema({ type: ['string', 'number'], enum: ['ready'] }) as { enum: unknown[] };
    expect(out).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
      enum: ['ready'],
    });
    expect(out.enum).toContain('ready');
    expect(out.enum).not.toContain('other');
    expect(out.enum).not.toContain(5);
  });

  it('preserves all non-null types and sets nullable when null is in the type-union array', () => {
    expect(sanitizeGeminiSchema({ type: ['string', 'number', 'null'] })).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
      nullable: true,
    });
  });

  it('preserves const restriction (normalized to enum) on a nullable string union', () => {
    const nullableString = sanitizeGeminiSchema({ type: ['string', 'null'], const: 'ready' }) as { enum: unknown[] };
    expect(nullableString).toEqual({ type: 'string', nullable: true, enum: ['ready'] });
    expect(nullableString.enum).toContain('ready');
    expect(nullableString.enum).not.toContain('other');

    const out = sanitizeGeminiSchema({ type: ['string', 'number', 'null'], const: 'ready' }) as { enum: unknown[] };
    expect(out).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
      nullable: true,
      enum: ['ready'],
    });
    expect(out.enum).toContain('ready');
    expect(out.enum).not.toContain('other');
    expect(out.enum).not.toContain(5);
  });

  it('preserves sibling constraints in object/string type-union', () => {
    const out = sanitizeGeminiSchema({
      type: ['object', 'string'],
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(out).toEqual({
      anyOf: [
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        { type: 'string' },
      ],
    });
  });

  it('preserves sibling items in array/string type-union', () => {
    const out = sanitizeGeminiSchema({ type: ['array', 'string'], items: { type: 'number' } });
    expect(out).toEqual({
      anyOf: [
        { type: 'array', items: { type: 'number' } },
        { type: 'string' },
      ],
    });
  });

  it('preserves wrapper scalar constraints on a type-union (minLength, minimum)', () => {
    expect(sanitizeGeminiSchema({ type: ['string', 'number'], minLength: 3, minimum: 10 })).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
      minLength: 3,
      minimum: 10,
    });
  });

  it('preserves wrapper nullable and title on a type-union', () => {
    expect(sanitizeGeminiSchema({ type: ['string', 'number'], title: 'Foo', nullable: true })).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
      title: 'Foo',
      nullable: true,
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

  it('distributes sibling properties/required into the object branch of a multi-alternative anyOf without adding a top-level type', () => {
    const schema = {
      anyOf: [{ type: 'object' }, { type: 'string' }],
      properties: { name: { type: 'string' } },
      required: ['name'],
    };
    const out = sanitizeGeminiSchema(schema);
    expect(out).toEqual({
      anyOf: [
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        { type: 'string' },
      ],
    });
  });

  it('preserves wrapper enum on a multi-alternative anyOf so value restrictions reach Gemini', () => {
    const schema = {
      type: 'string',
      enum: ['approved', 'denied'],
      anyOf: [{ type: 'string', minLength: 1 }, { type: 'string', maxLength: 20 }],
    };
    const out = sanitizeGeminiSchema(schema);
    expect(out).toEqual({
      enum: ['approved', 'denied'],
      anyOf: [
        { type: 'string', minLength: 1 },
        { type: 'string', maxLength: 20 },
      ],
    });
  });

  it('normalizes wrapper const to enum on a multi-alternative anyOf', () => {
    const schema = {
      type: 'string',
      const: 'ready',
      anyOf: [{ type: 'string', minLength: 1 }, { type: 'string', maxLength: 20 }],
    };
    const out = sanitizeGeminiSchema(schema);
    expect(out).toEqual({
      enum: ['ready'],
      anyOf: [
        { type: 'string', minLength: 1 },
        { type: 'string', maxLength: 20 },
      ],
    });
  });

  it('merges wrapper properties and required with object alternatives that already declare their own', () => {
    const schema = {
      anyOf: [
        { type: 'object', properties: { foo: { type: 'string' } }, required: ['foo'] },
        { type: 'object', properties: { bar: { type: 'string' } }, required: ['bar'] },
      ],
      properties: { id: { type: 'string' } },
      required: ['id'],
    };
    const out = sanitizeGeminiSchema(schema);
    expect(out).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: { id: { type: 'string' }, foo: { type: 'string' } },
          required: ['id', 'foo'],
        },
        {
          type: 'object',
          properties: { id: { type: 'string' }, bar: { type: 'string' } },
          required: ['id', 'bar'],
        },
      ],
    });
  });
});

// ── Built-in tool schema coverage ──────────────────────────────────────────────

function checkDeclaration(schema: unknown, path: string): void {
  expect(schema, path).toBeTypeOf('object');
  expect(schema, path).not.toBeNull();
  const node = schema as Record<string, unknown>;
  const supported = new Set([
    'type', 'title', 'description', 'nullable', 'format', 'enum', 'properties', 'required', 'items', 'anyOf',
    'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
  ]);
  for (const key of Object.keys(node)) expect(supported.has(key), `${path}.${key}`).toBe(true);
  if (node['type'] === 'array') {
    expect(node['items'], `${path}.items`).toBeDefined();
    checkDeclaration(node['items'], `${path}.items`);
  }
  for (const [name, child] of Object.entries((node['properties'] ?? {}) as Record<string, unknown>)) {
    checkDeclaration(child, `${path}.properties.${name}`);
  }
  if (Array.isArray(node['anyOf'])) node['anyOf'].forEach((child, i) => checkDeclaration(child, `${path}.anyOf.${i}`));
}

describe('built-in Gemini declarations (F07)', () => {
  it('emits every real built-in schema with items on every array and only supported keywords', async () => {
    // Schema generation never executes a tool; enable web_search to include the optional built-in too.
    const builtins = createBuiltinTools({
      stores: {} as ProductivityStores,
      memory: {} as MemoryService,
      webSearch: { provider: 'brave', apiKey: 'fixture' },
    });
    const tools = builtins.map((tool) => ({
      name: tool.name, description: tool.description, inputSchema: toolInputJsonSchema(tool.inputSchema),
    }));
    const { a, f } = make(okReply);
    await collect(a.chat(req({ tools })));
    const declarations = (f.calls[0]!.body!['tools'] as { functionDeclarations: { name: string; parameters?: unknown }[] }[])[0]!.functionDeclarations;
    expect(declarations.map((d) => d.name)).toEqual(builtins.map((tool) => tool.name));
    expect(declarations.map((d) => d.name)).toContain('web_search');
    for (const declaration of declarations) {
      if (declaration.parameters !== undefined) checkDeclaration(declaration.parameters, declaration.name);
    }
  });
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

  it('abort after first tool_call in a multi-call chunk is honoured', async () => {
    const ac = new AbortController();
    const { a } = make(stream(
      cand([
        { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
        { functionCall: { name: 'get_weather', args: { city: 'Rome' } } },
      ], 'STOP'),
    ));
    const it = a.chat(req({ signal: ac.signal, tools: TOOLS }))[Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ type: 'tool_call', name: 'get_weather', input: { city: 'Paris' } });
    ac.abort();
    await expect(it.next()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it.each([
    ['text', [{ text: 'First' }, { text: 'Second' }], 'text'],
    ['reasoning', [{ text: 'First', thought: true }, { text: 'Second', thought: true }], 'reasoning'],
    ['reasoning_part', [{ text: 'First', thought: true, thoughtSignature: 'signature' }], 'reasoning'],
  ] as const)('abort before %s in a multi-event chunk is honoured', async (_nextType, parts, firstType) => {
    const ac = new AbortController();
    const { a } = make(stream(cand([...parts], 'STOP')));
    const it = a.chat(req({ signal: ac.signal }))[Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ type: firstType });
    ac.abort();
    await expect(it.next()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it.each([
    ['sources', 'text'],
    ['usage', 'sources'],
    ['done', 'usage'],
  ] as const)('abort before post-stream %s is honoured', async (_nextType, firstType) => {
    const ac = new AbortController();
    const { a } = make(stream({
      candidates: [{
        content: { parts: [] },
        finishReason: 'SAFETY',
        groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }] },
      }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
    }));
    const it = a.chat(req({ signal: ac.signal, webSearch: {} }))[Symbol.asyncIterator]();
    let first = await it.next();
    while (!first.done && first.value.type !== firstType) first = await it.next();
    expect(first.value).toMatchObject({ type: firstType });
    ac.abort();
    await expect(it.next()).rejects.toMatchObject({ code: 'cancelled' });
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
  it('abort while reading error body throws cancelled, not provider_error', async () => {
    const controller = new AbortController();
    const f = fakeFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.error(new DOMException('aborted', 'AbortError'));
        },
      });
      controller.abort();
      return new Response(body, { status: 400 });
    });
    const { sleep } = make([] as FakeResponder[]);
    const a = new GeminiAdapter(cfg(), { fetch: f, sleep });
    await expect(collect(a.chat(req({ signal: controller.signal })))).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('abort while reading retry-info body throws cancelled instead of retrying through to a later success', async () => {
    const f = fakeFetch([
      () => {
        const body = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.error(new DOMException('aborted', 'AbortError'));
          },
        });
        return new Response(body, { status: 429 });
      },
      stream(cand([{ text: 'Hi' }], 'STOP')),
    ]);
    const { sleep } = make([] as FakeResponder[]);
    const a = new GeminiAdapter(cfg(), { fetch: f, sleep });
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.calls.length).toBe(1);
  });

  it('does not expose malformed model-response text in errors or connection tests', async () => {
    const { a } = make(() => new Response(KEY, { headers: { 'Content-Type': 'application/json' } }));
    const error = await a.listModels().catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'provider_error', message: 'Gemini returned invalid model data.' });
    expect(error).not.toHaveProperty('cause');
    expect(await a.test()).toMatchObject({ ok: false, error: 'Gemini returned invalid model data.' });
  });

  it.each([null, { models: null }, { models: KEY }])('rejects malformed model-list structures safely: %j', async (body) => {
    const { a } = make(() => jsonResponse(body));
    await expect(a.listModels()).rejects.toMatchObject({ code: 'provider_error', message: 'Gemini returned invalid model data.' });
  });

  it('ignores invalid entries and redacts echoed credentials in labels', async () => {
    const { a } = make(() => jsonResponse({ models: [null, 42, KEY, { name: {} }, { name: 'models/gemini-3-pro', displayName: `Model ${KEY}`, supportedGenerationMethods: ['generateContent'] }] }));
    const models = await a.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'gemini-3-pro', label: 'Model [redacted]' });
    expect(JSON.stringify(models)).not.toContain(KEY);
  });

  it('rejects credential echoes in model ids and page tokens', async () => {
    const { a } = make([
      () => jsonResponse({ models: [{ name: `models/${KEY}`, supportedGenerationMethods: ['generateContent'] }] }),
      () => jsonResponse({ models: [], nextPageToken: KEY }),
    ]);
    await expect(a.listModels()).rejects.toMatchObject({ code: 'provider_error', message: 'Gemini returned invalid model data.' });
    await expect(a.listModels()).rejects.toMatchObject({ code: 'provider_error', message: 'Gemini returned invalid model data.' });
  });

  const gErr = (status: number, message: string, extra: Record<string, unknown> = {}): FakeResponder => () =>
    jsonResponse({ error: { code: status, message, status: 'X', ...extra } }, status);

  it('an invalid key (HTTP 400 API_KEY_INVALID) is provider_auth', async () => {
    const { a } = make(gErr(400, 'API key not valid. Please pass a valid API key.', { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] }));
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_auth' });
  });

  it('an in-stream 401 error on HTTP 200 is a nonretryable provider_auth NeoError', async () => {
    const { a, f, sleep } = make(stream({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'Invalid credentials' } }));
    const error = await collect(a.chat(req())).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(NeoError);
    expect(error).toMatchObject({ code: 'provider_auth', retryable: false, details: { status: 401 } });
    expect(f.calls).toHaveLength(1);
    expect(sleep.delays).toEqual([]);
  });

  it.each([
    [{ code: 403 }, 'provider_auth', false],
    [{ status: 'UNAUTHENTICATED' }, 'provider_auth', false],
    [{ status: 'PERMISSION_DENIED' }, 'provider_auth', false],
    [{ code: 429, status: 'UNAUTHENTICATED' }, 'provider_auth', false],
    [{ code: 429, details: [{ reason: 'API_KEY_INVALID' }] }, 'provider_auth', false],
    [{ code: 429, message: 'API key not valid. Please pass a valid API key.' }, 'provider_auth', false],
    [{ code: 401, status: 'RESOURCE_EXHAUSTED' }, 'provider_auth', false],
    [{ code: 429 }, 'rate_limited', true],
    [{ status: 'RESOURCE_EXHAUSTED' }, 'rate_limited', true],
    [{ code: 500 }, 'provider_error', true],
    [{ code: 503 }, 'provider_error', true],
    [{ code: 400 }, 'provider_error', false],
    [{ code: 404 }, 'provider_error', false],
    [{}, 'provider_error', false],
    [{ status: 'INTERNAL' }, 'provider_error', true],
    [{ status: 'UNAVAILABLE' }, 'provider_error', true],
    [{ status: 'DEADLINE_EXCEEDED' }, 'provider_error', true],
    [{ status: 'DATA_LOSS' }, 'provider_error', true],
    [{ status: 'UNKNOWN' }, 'provider_error', true],
  ])('classifies in-stream Gemini errors without retrying: %j', async (error, code, retryable) => {
    const { a, f, sleep } = make(stream({ error: { message: 'Request failed', ...error } }));
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code, retryable });
    expect(f.calls).toHaveLength(1);
    expect(sleep.delays).toEqual([]);
  });

  it.each([
    [{ retryAfter: 2.5 }, 2500],
    [{ retryAfter: '3' }, 3000],
    [{ retryDelay: '1.5s' }, 1500],
    [{ retryDelay: 4 }, 4000],
    [{ details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }] }, 30_000],
    [{ retryAfter: 0, details: [{ retryDelay: '30s' }] }, 0],
  ])('preserves in-stream Gemini rate-limit retry metadata: %j', async (extra, retryAfterMs) => {
    const { a, f, sleep } = make(stream({ error: { code: 429, message: 'Quota exhausted', ...extra } }));
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'rate_limited', retryable: true, details: { status: 429, retryAfterMs } });
    expect(f.calls).toHaveLength(1);
    expect(sleep.delays).toEqual([]);
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

  it.each(['Cookie', 'cookie', 'COOKIE', 'Set-Cookie'])('redacts %s custom headers from error messages', async (name) => {
    const cookie = 'session=private-cookie-value';
    const { a, f } = make(gErr(401, `Unauthorized: ${cookie}`, { status: 'UNAUTHENTICATED' }), { headers: { [name]: cookie } });
    const error = (await collect(a.chat(req())).catch((err: unknown) => err)) as NeoError;
    expect(error).toBeInstanceOf(NeoError);
    expect(error).toMatchObject({ code: 'provider_auth' });
    expect(error.message).toContain('Unauthorized');
    expect(error.message).not.toContain('private-cookie-value');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.headers.get(name)).toBe(cookie);
  });

  it('listModels follows pages and keeps text and embedding models with their own capabilities', async () => {
    const { a, f } = make([
      () => jsonResponse({ models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 }], nextPageToken: 'p2' }),
      () => jsonResponse({ models: [{ name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }, { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['batchEmbedContents'] }, { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] }, { name: 'models/unsupported', supportedGenerationMethods: ['countTokens'] }] }),
    ]);
    const models = await a.listModels();
    expect(f.calls.map((c) => c.url)).toEqual([`${BASE}/models?pageSize=200`, `${BASE}/models?pageSize=200&pageToken=p2`]);
    expect(f.calls[0]!.headers.get('x-goog-api-key')).toBe(KEY);
    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-pro', 'text-embedding-004', 'gemini-embedding-001', 'gemini-2.5-flash']);
    expect(models[0]!.capabilities).toMatchObject({ text: true, contextWindow: 1_048_576, maxOutputTokens: 65_536, reasoning: true, vision: true, embeddings: false });
    expect(models[1]!.capabilities).toMatchObject({ text: false, tools: false, vision: false, reasoning: false, embeddings: true });
    expect(models[2]!.capabilities).toMatchObject({ text: false, embeddings: true });
  });

  it('uses listing methods to distinguish a dual-purpose model from embedding-only and future generation models', async () => {
    const { a } = make(() => jsonResponse({ models: [
      { name: 'models/dual-purpose', supportedGenerationMethods: ['generateContent', 'embedContent'] },
      { name: 'models/vector-model', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] },
      { name: 'models/veo-3.0-generate-001', supportedGenerationMethods: ['predictLongRunning'] },
    ] }));
    const models = await a.listModels();
    expect(models.map((m) => [m.id, m.capabilities.text, m.capabilities.embeddings, m.capabilities.textToSpeech, m.capabilities.image, m.capabilities.video])).toEqual([
      ['dual-purpose', true, true, false, false, false],
      ['vector-model', false, true, false, false, false],
      ['gemini-2.5-flash-preview-tts', false, false, true, false, false],
      ['imagen-4.0-generate-001', false, false, false, true, false],
      ['veo-3.0-generate-001', false, false, false, false, true],
    ]);
    expect(a.capabilities('models/vector-model')).toMatchObject({ text: false, embeddings: true });
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
