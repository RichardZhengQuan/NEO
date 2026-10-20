import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatRequest, ProviderAdapter, ProviderConfig } from '@neo/protocol';
import { collectChat, NeoError } from '@neo/protocol';
import { AnthropicAdapter } from './anthropic.js';
import type { ProviderOptions } from './index.js';
import {
  collect,
  fakeFetch,
  jsonResponse,
  ofType,
  recordingSleep,
  sseResponse,
  textOfEvents,
  typedFrames,
  type FakeResponder,
} from './testing/http.js';

// ───────────────────────────── fixtures ─────────────────────────────

const KEY = 'sk-ant-test-0123456789abcdef';

function config(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: 'anthropic', kind: 'anthropic', apiKey: KEY, enabled: true, ...over };
}

type Frame = { type: string } & Record<string, unknown>;

function messageStart(model = 'claude-opus-5-5', usage: Record<string, number> = { input_tokens: 10, output_tokens: 1 }): Frame {
  return {
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
  };
}
const textBlock = (index: number, ...parts: string[]): Frame[] => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  ...parts.map((text) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })),
  { type: 'content_block_stop', index },
];
const thinkingBlock = (index: number, thinking: string[], signature: string[]): Frame[] => [
  { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
  ...thinking.map((t) => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: t } })),
  ...signature.map((s) => ({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: s } })),
  { type: 'content_block_stop', index },
];
const redactedBlock = (index: number, data: string): Frame[] => [
  { type: 'content_block_start', index, content_block: { type: 'redacted_thinking', data } },
  { type: 'content_block_stop', index },
];
const toolBlock = (index: number, id: string, name: string, ...json: string[]): Frame[] => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
  ...json.map((partial_json) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })),
  { type: 'content_block_stop', index },
];
const fallbackBlock = (index: number): Frame[] => [
  {
    type: 'content_block_start',
    index,
    content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal' } },
  },
  { type: 'content_block_stop', index },
];
const messageDelta = (stop_reason: string, usage: Record<string, number | null> = { output_tokens: 20 }): Frame => ({
  type: 'message_delta',
  delta: { stop_reason, stop_sequence: null, stop_details: null, container: null },
  usage,
});
const messageStop: Frame = { type: 'message_stop' };

function stream(...frames: (Frame | Frame[])[]): FakeResponder {
  return () => sseResponse(typedFrames(frames.flat()));
}

function apiError(status: number, message: string, type = 'invalid_request_error', headers: Record<string, string> = {}): FakeResponder {
  return () => jsonResponse({ type: 'error', error: { type, message } }, status, { 'request-id': 'req_1', ...headers });
}

const user = (text: string): ChatMessage => ({ role: 'user', parts: [{ type: 'text', text }] });
const simpleReply = stream(messageStart(), textBlock(0, 'Hi'), messageDelta('end_turn'), messageStop);

function req(over: Partial<ChatRequest> = {}): ChatRequest {
  return { model: 'claude-opus-5-5', messages: [user('hello')], ...over };
}

function adapter(responders: FakeResponder | FakeResponder[], cfg: Partial<ProviderConfig> = {}, opts: ProviderOptions = {}) {
  const f = fakeFetch(responders);
  const sleep = recordingSleep();
  const a = new AnthropicAdapter(config(cfg), { fetch: f, sleep, ...opts });
  return { a, f, sleep };
}

const TOOLS = [{ name: 'get_weather', description: 'Weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }];

// ───────────────────────────── request shape ─────────────────────────────

describe('Anthropic request shape', () => {
  it('claude-opus-5-5: adaptive summarized thinking, effort, no sampling params, top-level cache_control, refusal fallback', async () => {
    const { a, f } = adapter(simpleReply);
    await collect(a.chat(req({ system: 'Be nice.', temperature: 0.2, reasoning: 'high', tools: TOOLS, toolChoice: 'auto' })));
    const body = f.calls[0]!.body!;
    expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(JSON.stringify(body)).not.toContain('budget_tokens');
    expect(body['output_config']).toEqual({ effort: 'high' });
    expect(body).not.toHaveProperty('temperature');
    expect(body['cache_control']).toEqual({ type: 'ephemeral' });
    expect(body['system']).toBe('Be nice.');
    expect(body['max_tokens']).toBe(16_000);
    expect(body['stream']).toBe(true);
    expect(body['tools']).toEqual([
      { name: 'get_weather', description: 'Weather', input_schema: TOOLS[0]!.inputSchema, eager_input_streaming: true },
    ]);
    // auto is the API default; forced tool choice is never sent.
    expect(body).not.toHaveProperty('tool_choice');
    expect(body['fallbacks']).toBe('default');
    expect(f.calls[0]!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(f.calls[0]!.headers.get('x-api-key')).toBe(KEY);
  });

  it.each([
    ['off', 'low'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
  ] as const)('maps reasoning %s → effort %s', async (reasoning, effort) => {
    const { a, f } = adapter(simpleReply);
    await collect(a.chat(req({ reasoning })));
    expect(f.calls[0]!.body!['output_config']).toEqual({ effort });
  });

  it.each(['claude-sonnet-5-5', 'claude-fable-5-1'])('%s gets adaptive thinking and the refusal fallback', async (model) => {
    const { a, f } = adapter(stream(messageStart(model), textBlock(0, 'ok'), messageDelta('end_turn'), messageStop));
    await collect(a.chat(req({ model, temperature: 0.5 })));
    const body = f.calls[0]!.body!;
    expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body).not.toHaveProperty('temperature');
    expect(body['fallbacks']).toBe('default');
  });

  it.each(['claude-haiku-5-5', 'claude-mythos-5-1', 'claude-opus-4-8', 'claude-sonnet-4-6'])(
    '%s: adaptive thinking, no temperature, no fallback',
    async (model) => {
      const { a, f } = adapter(stream(messageStart(model), textBlock(0, 'ok'), messageDelta('end_turn'), messageStop));
      await collect(a.chat(req({ model, temperature: 0.5, reasoning: 'medium' })));
      const body = f.calls[0]!.body!;
      expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body).not.toHaveProperty('temperature');
      expect(body['output_config']).toEqual({ effort: 'medium' });
      expect(body).not.toHaveProperty('fallbacks');
      expect(f.calls[0]!.headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback');
    },
  );

  it('claude-haiku-4-5 (older model): no thinking, no effort, temperature allowed', async () => {
    const { a, f } = adapter(stream(messageStart('claude-haiku-4-5'), textBlock(0, 'ok'), messageDelta('end_turn'), messageStop));
    await collect(a.chat(req({ model: 'claude-haiku-4-5', temperature: 0.3, reasoning: 'off' })));
    const body = f.calls[0]!.body!;
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('output_config');
    expect(body['temperature']).toBe(0.3);
    expect(body).not.toHaveProperty('fallbacks');
  });

  it('sends tool_choice none only together with tools', async () => {
    const { a, f } = adapter([simpleReply, simpleReply]);
    await collect(a.chat(req({ toolChoice: 'none' })));
    expect(f.calls[0]!.body).not.toHaveProperty('tool_choice');
    await collect(a.chat(req({ toolChoice: 'none', tools: TOOLS })));
    expect(f.calls[1]!.body!['tool_choice']).toEqual({ type: 'none' });
  });

  it('json mode appends the instruction to the system prompt (no prefill)', async () => {
    const { a, f } = adapter(simpleReply);
    await collect(a.chat(req({ system: 'Extract.', responseFormat: 'json' })));
    const body = f.calls[0]!.body!;
    expect(body['system']).toBe('Extract.\n\nRespond with a single JSON object only.');
    const messages = body['messages'] as { role: string }[];
    expect(messages.at(-1)!.role).toBe('user');
  });

  it('respects options.refusalFallback=false and custom headers', async () => {
    const { a, f } = adapter(simpleReply, { options: { refusalFallback: false }, headers: { 'x-team': 'neo' } });
    await collect(a.chat(req()));
    expect(f.calls[0]!.body).not.toHaveProperty('fallbacks');
    expect(f.calls[0]!.headers.get('x-team')).toBe('neo');
  });

  it('uses the configured base URL', async () => {
    const { a, f } = adapter(simpleReply, { baseUrl: 'https://proxy.example.com' });
    await collect(a.chat(req()));
    expect(f.calls[0]!.url.startsWith('https://proxy.example.com/v1/messages')).toBe(true);
  });
});

// ───────────────────────────── message mapping ─────────────────────────────

describe('Anthropic message mapping', () => {
  const sig = 'EqQBCkYIBxgCKkB-signature';

  it('replays thinking verbatim (with signature) only for the same provider + model, before text and tool_use', async () => {
    const { a, f } = adapter(simpleReply);
    const history: ChatMessage[] = [
      user('weather?'),
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'Let me check.', provider: 'anthropic', model: 'claude-opus-5-5', data: { type: 'thinking', signature: sig } },
          { type: 'reasoning', text: '', provider: 'anthropic', model: 'claude-opus-5-5', redacted: true, data: { type: 'redacted_thinking', data: 'ENC' } },
          { type: 'reasoning', text: 'other model', provider: 'anthropic', model: 'claude-sonnet-5-5', data: { type: 'thinking', signature: 'x' } },
          { type: 'reasoning', text: 'gemini thought', provider: 'gemini', model: 'claude-opus-5-5', data: { thoughtSignature: 'g' } },
          { type: 'reasoning', text: 'no data', provider: 'anthropic', model: 'claude-opus-5-5' },
          { type: 'text', text: 'Checking.' },
          { type: 'tool_call', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
        ],
      },
      { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'toolu_1', name: 'get_weather', output: { tempC: 21 } }] },
    ];
    await collect(a.chat(req({ messages: history, tools: TOOLS })));
    const messages = f.calls[0]!.body!['messages'] as { role: string; content: Record<string, unknown>[] }[];
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me check.', signature: sig },
        { type: 'redacted_thinking', data: 'ENC' },
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
      ],
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"tempC":21}' }],
    });
  });

  it('drops all reasoning when the request is for a different model', async () => {
    const { a, f } = adapter(stream(messageStart('claude-haiku-4-5'), textBlock(0, 'ok'), messageDelta('end_turn'), messageStop));
    await collect(
      a.chat(
        req({
          model: 'claude-haiku-4-5',
          messages: [
            user('hi'),
            { role: 'assistant', parts: [{ type: 'reasoning', text: 't', provider: 'anthropic', model: 'claude-opus-5-5', data: { type: 'thinking', signature: sig } }, { type: 'text', text: 'Hello' }] },
            user('again'),
          ],
        }),
      ),
    );
    const messages = f.calls[0]!.body!['messages'] as { role: string; content: unknown[] }[];
    expect(messages[1]!.content).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('puts all tool results first in one user message, followed by user text; errors carry is_error', async () => {
    const { a, f } = adapter(simpleReply);
    await collect(
      a.chat(
        req({
          tools: TOOLS,
          messages: [
            user('two things'),
            {
              role: 'assistant',
              parts: [
                { type: 'tool_call', id: 't1', name: 'get_weather', input: { city: 'A' } },
                { type: 'tool_call', id: 't2', name: 'get_weather', input: { city: 'B' } },
              ],
            },
            {
              role: 'tool',
              parts: [
                { type: 'tool_result', toolCallId: 't1', name: 'get_weather', output: 'sunny' },
                { type: 'tool_result', toolCallId: 't2', name: 'get_weather', output: { error: 'boom' }, isError: true },
              ],
            },
            user('thanks'),
          ],
        }),
      ),
    );
    const messages = f.calls[0]!.body!['messages'] as { role: string; content: unknown[] }[];
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'sunny' },
        { type: 'tool_result', tool_use_id: 't2', content: '{"error":"boom"}', is_error: true },
        { type: 'text', text: 'thanks' },
      ],
    });
  });

  it('maps base64 and URL images; unsupported image types become a text note', async () => {
    const { a, f } = adapter(simpleReply);
    await collect(
      a.chat(
        req({
          messages: [
            {
              role: 'user',
              parts: [
                { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
                { type: 'image', mediaType: 'image/jpeg', url: 'https://example.com/cat.jpg' },
                { type: 'image', mediaType: 'image/heic', data: 'AAAA' },
                { type: 'text', text: 'what is this?' },
              ],
            },
          ],
        }),
      ),
    );
    const content = (f.calls[0]!.body!['messages'] as { content: unknown[] }[])[0]!.content;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } });
    expect(content[1]).toEqual({ type: 'image', source: { type: 'url', url: 'https://example.com/cat.jpg' } });
    expect(content[2]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(content[2])).toContain('image/heic');
    expect(content[3]).toEqual({ type: 'text', text: 'what is this?' });
  });

  it('never sends empty text blocks', async () => {
    const { a, f } = adapter(simpleReply);
    await collect(a.chat(req({ messages: [{ role: 'user', parts: [{ type: 'text', text: '' }, { type: 'text', text: 'hi' }] }] })));
    expect((f.calls[0]!.body!['messages'] as { content: unknown[] }[])[0]!.content).toEqual([{ type: 'text', text: 'hi' }]);
  });
});

// ───────────────────────────── streaming translation ─────────────────────────────

describe('Anthropic streaming', () => {
  it('translates text, thinking (with signature), redacted thinking, interleaved tool calls and usage', async () => {
    const { a } = adapter(
      stream(
        messageStart('claude-opus-5-5', { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }),
        thinkingBlock(0, ['Thinking ', 'hard.'], ['sig-a', 'sig-b']),
        redactedBlock(1, 'ENCRYPTED'),
        textBlock(2, 'Let me ', 'check.'),
        toolBlock(3, 'toolu_a', 'get_weather', '{"ci', 'ty": "Pa', 'ris"}'),
        toolBlock(4, 'toolu_b', 'get_weather', '{"city":', ' "Rome"}'),
        toolBlock(5, 'toolu_c', 'get_weather', '{"city": "Oslo'),
        messageDelta('tool_use', { output_tokens: 250, input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }),
        messageStop,
      ),
    );
    const events = await collect(a.chat(req({ tools: TOOLS })));

    expect(ofType(events, 'reasoning').map((e) => e.text).join('')).toBe('Thinking hard.');
    expect(textOfEvents(events)).toBe('Let me check.');
    expect(ofType(events, 'reasoning_part').map((e) => e.part)).toEqual([
      { type: 'reasoning', text: 'Thinking hard.', provider: 'anthropic', model: 'claude-opus-5-5', data: { type: 'thinking', signature: 'sig-asig-b' } },
      { type: 'reasoning', text: '', provider: 'anthropic', model: 'claude-opus-5-5', redacted: true, data: { type: 'redacted_thinking', data: 'ENCRYPTED' } },
    ]);
    expect(ofType(events, 'tool_call').map(({ id, name, input }) => ({ id, name, input }))).toEqual([
      { id: 'toolu_a', name: 'get_weather', input: { city: 'Paris' } },
      { id: 'toolu_b', name: 'get_weather', input: { city: 'Rome' } },
      { id: 'toolu_c', name: 'get_weather', input: { __invalid_json: '{"city": "Oslo' } },
    ]);
    const usage = ofType(events, 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 250, cacheReadTokens: 900, cacheWriteTokens: 50 });
    expect(ofType(events, 'done')).toEqual([{ type: 'done', stopReason: 'tool_use' }]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
    expect(events.at(-2)!.type).toBe('usage');
  });

  it('emits each reasoning_part when its block ends, before later text (core places parts in arrival order)', async () => {
    const { a } = adapter(stream(messageStart(), redactedBlock(0, 'ENC'), thinkingBlock(1, [], ['sig-empty']), textBlock(2, 'Answer'), messageDelta('end_turn'), messageStop));
    const events = await collect(a.chat(req()));
    expect(events.map((e) => e.type).slice(0, 3)).toEqual(['reasoning_part', 'reasoning_part', 'text']);
    expect(ofType(events, 'reasoning_part')[1]!.part).toMatchObject({ text: '', data: { type: 'thinking', signature: 'sig-empty' } });
  });

  it('collectChat sees the real input token count (single usage event)', async () => {
    const { a } = adapter(stream(messageStart('claude-opus-5-5', { input_tokens: 42, output_tokens: 1 }), textBlock(0, 'ok'), messageDelta('end_turn', { output_tokens: 7 }), messageStop));
    const result = await collectChat(a.chat(req()));
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  it.each([
    ['end_turn', 'end'],
    ['stop_sequence', 'end'],
    ['pause_turn', 'end'],
    ['max_tokens', 'max_tokens'],
    ['model_context_window_exceeded', 'max_tokens'],
  ] as const)('maps stop_reason %s → %s', async (stop, expected) => {
    const { a } = adapter(stream(messageStart(), textBlock(0, 'x'), messageDelta(stop), messageStop));
    const events = await collect(a.chat(req()));
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: expected });
  });

  it('refusal before any output yields a short note; a partial answer is left alone and its tool calls are dropped', async () => {
    const { a: a1 } = adapter(stream(messageStart(), messageDelta('refusal'), messageStop));
    const e1 = await collect(a1.chat(req()));
    expect(textOfEvents(e1).length).toBeGreaterThan(0);
    expect(e1.at(-1)).toEqual({ type: 'done', stopReason: 'refusal' });

    const { a: a2 } = adapter(
      stream(messageStart(), textBlock(0, 'Here is part'), toolBlock(1, 'toolu_x', 'get_weather', '{"city":"X"}'), messageDelta('refusal'), messageStop),
    );
    const e2 = await collect(a2.chat(req({ tools: TOOLS })));
    expect(textOfEvents(e2)).toBe('Here is part');
    expect(ofType(e2, 'tool_call')).toHaveLength(0);
    expect(e2.at(-1)).toEqual({ type: 'done', stopReason: 'refusal' });
  });

  it('server-side fallback mid-stream: tool calls before the fallback marker are never run', async () => {
    const { a } = adapter(
      stream(
        messageStart(),
        thinkingBlock(0, ['declined thought'], ['sig-old']),
        textBlock(1, 'Partial '),
        toolBlock(2, 'toolu_old', 'get_weather', '{"city":"Old"}'),
        fallbackBlock(3),
        thinkingBlock(4, ['new thought'], ['sig-new']),
        textBlock(5, 'answer'),
        toolBlock(6, 'toolu_new', 'get_weather', '{"city":"New"}'),
        messageDelta('tool_use'),
        messageStop,
      ),
    );
    const events = await collect(a.chat(req({ tools: TOOLS })));
    expect(textOfEvents(events)).toBe('Partial answer');
    expect(ofType(events, 'tool_call').map((e) => e.id)).toEqual(['toolu_new']);
  });

  it('a stream that ends without message_stop is an error, not a silent success', async () => {
    const { a } = adapter(stream(messageStart(), textBlock(0, 'cut')));
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_error', retryable: true });
  });

  it('a mid-stream error event is mapped and never retried', async () => {
    const { a, f } = adapter(() =>
      sseResponse(
        typedFrames([messageStart(), ...textBlock(0, 'Hel')]) +
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`,
      ),
    );
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const ev of a.chat(req())) if (ev.type === 'text') seen.push(ev.text);
      })(),
    ).rejects.toMatchObject({ code: 'provider_error', retryable: true, message: expect.stringContaining('Overloaded') });
    expect(seen.join('')).toBe('Hel');
    expect(f.calls).toHaveLength(1);
  });

  it('abort after first tool_call in post-stream batch is honoured', async () => {
    const ac = new AbortController();
    const { a } = adapter(stream(
      messageStart(),
      toolBlock(0, 'toolu_1', 'get_weather', '{"city":"Paris"}'),
      toolBlock(1, 'toolu_2', 'get_weather', '{"city":"Rome"}'),
      messageDelta('tool_use'),
      messageStop,
    ));
    const it = a.chat(req({ signal: ac.signal, tools: TOOLS }))[Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ type: 'tool_call', id: 'toolu_1', input: { city: 'Paris' } });
    ac.abort();
    await expect(it.next()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it.each([
    ['provider_part', 'tool_call', 'tool_use'],
    ['text', 'provider_part', 'refusal'],
    ['sources', 'provider_part', 'end_turn'],
    ['usage', 'sources', 'end_turn'],
    ['done', 'usage', 'end_turn'],
  ] as const)('abort before post-stream %s is honoured', async (_nextType, firstType, stop) => {
    const ac = new AbortController();
    const { a } = adapter(stream(
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Example', encrypted_content: 'opaque' }] } },
      { type: 'content_block_stop', index: 0 },
      toolBlock(1, 'toolu_1', 'get_weather', '{"city":"Paris"}'),
      messageDelta(stop),
      messageStop,
    ));
    const it = a.chat(req({ signal: ac.signal, tools: TOOLS, webSearch: {} }))[Symbol.asyncIterator]();
    let first = await it.next();
    while (!first.done && first.value.type !== firstType) first = await it.next();
    expect(first.value).toMatchObject({ type: firstType });
    ac.abort();
    await expect(it.next()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('abort mid-stream ends with NeoError cancelled', async () => {
    const ac = new AbortController();
    const { a } = adapter((r) =>
      sseResponse(typedFrames([messageStart(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }]), {
        hang: true,
        signal: r.signal,
      }),
    );
    const it = a.chat(req({ signal: ac.signal }))[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value).toEqual({ type: 'text', text: 'Hi' });
    ac.abort();
    await expect(it.next()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('an already-aborted signal never reaches the network', async () => {
    const ac = new AbortController();
    ac.abort();
    const { a, f } = adapter(simpleReply);
    await expect(collect(a.chat(req({ signal: ac.signal })))).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.calls).toHaveLength(0);
  });
});

// ───────────────────────────── retries & errors ─────────────────────────────

describe('Anthropic retries and errors', () => {
  it('strips every thinking block and retries once on the "bound to a different conversation" 400', async () => {
    const sigError = apiError(
      400,
      'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header.',
    );
    const { a, f } = adapter([sigError, simpleReply]);
    const history: ChatMessage[] = [
      user('q'),
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'r', provider: 'anthropic', model: 'claude-opus-5-5', data: { type: 'thinking', signature: 's' } },
          { type: 'text', text: 'a' },
        ],
      },
      user('q2'),
    ];
    const events = await collect(a.chat(req({ messages: history })));
    expect(textOfEvents(events)).toBe('Hi');
    expect(f.calls).toHaveLength(2);
    expect(JSON.stringify(f.calls[0]!.body!['messages'])).toContain('"thinking"');
    expect(JSON.stringify(f.calls[1]!.body!['messages'])).not.toContain('"thinking"');
    // The refusal fallback is not blamed for a thinking error.
    expect(f.calls[1]!.body!['fallbacks']).toBe('default');
  });

  it('retries the signature error only once', async () => {
    const sigError = apiError(400, 'messages.1.content.0: Invalid `signature` in `thinking` block.');
    const { a, f } = adapter([sigError, sigError, simpleReply]);
    const history: ChatMessage[] = [
      user('q'),
      { role: 'assistant', parts: [{ type: 'reasoning', text: 'r', provider: 'anthropic', model: 'claude-opus-5-5', data: { type: 'thinking', signature: 's' } }, { type: 'text', text: 'a' }] },
      user('q2'),
    ];
    await expect(collect(a.chat(req({ messages: history })))).rejects.toMatchObject({ code: 'provider_error' });
    expect(f.calls).toHaveLength(2);
  });

  it('does not strip-and-retry unrelated 400s that merely mention thinking', async () => {
    const { a, f } = adapter([apiError(400, '"thinking.type.disabled" is not supported for this model.'), simpleReply]);
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_error', retryable: false });
    expect(f.calls).toHaveLength(1);
  });

  it('disables the refusal fallback for the adapter lifetime after the API rejects it', async () => {
    const rejected = apiError(400, 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.');
    const { a, f } = adapter([rejected, simpleReply, simpleReply]);
    expect(textOfEvents(await collect(a.chat(req())))).toBe('Hi');
    expect(f.calls[0]!.body!['fallbacks']).toBe('default');
    expect(f.calls[1]!.body).not.toHaveProperty('fallbacks');
    expect(f.calls[1]!.headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback');
    await collect(a.chat(req()));
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2]!.body).not.toHaveProperty('fallbacks');
  });

  it('retries 429/5xx before the first byte (≤ 2 retries, honoring retry-after ≤ 10 s)', async () => {
    const { a, f, sleep } = adapter([
      apiError(429, 'Slow down', 'rate_limit_error', { 'retry-after': '2' }),
      apiError(529, 'Overloaded', 'overloaded_error'),
      simpleReply,
    ]);
    expect(textOfEvents(await collect(a.chat(req())))).toBe('Hi');
    expect(f.calls).toHaveLength(3);
    expect(sleep.delays).toEqual([2000, 1500]);
  });

  it('gives up after 2 retries and maps 429 to rate_limited with retryAfterMs', async () => {
    const limited = apiError(429, 'Slow down', 'rate_limit_error', { 'retry-after': '3' });
    const { a, f } = adapter([limited, limited, limited, simpleReply]);
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'rate_limited', retryable: true, details: { retryAfterMs: 3000 } });
    expect(f.calls).toHaveLength(3);
  });

  it('does not wait out a retry-after longer than 10 s', async () => {
    const { a, f, sleep } = adapter([apiError(429, 'Slow down', 'rate_limit_error', { 'retry-after': '60' }), simpleReply]);
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'rate_limited', details: { retryAfterMs: 60_000 } });
    expect(f.calls).toHaveLength(1);
    expect(sleep.delays).toEqual([]);
  });

  it('never retries other 4xx (e.g. 408/409)', async () => {
    const { a, f } = adapter([apiError(409, 'Conflict', 'api_error'), simpleReply]);
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_error' });
    expect(f.calls).toHaveLength(1);
  });

  it('maps 401 to provider_auth with the API message (not a JSON dump)', async () => {
    const { a } = adapter(apiError(401, 'invalid x-api-key', 'authentication_error'));
    const err = await collect(a.chat(req())).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'provider_auth' });
    expect((err as Error).message).toContain('invalid x-api-key');
    expect((err as Error).message).not.toContain('{"type"');
  });

  it('maps 403 to provider_auth', async () => {
    const { a } = adapter(apiError(403, 'not allowed', 'permission_error'));
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_auth' });
  });

  it('redacts the API key from error messages', async () => {
    const { a } = adapter(apiError(400, `bad key ${KEY} in request`));
    const err = (await collect(a.chat(req())).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(KEY);
  });

  it('redacts credential-bearing custom headers from error messages', async () => {
    const { a, f } = adapter(apiError(400, 'bad authorization Bearer HEADER_SECRET (token HEADER_SECRET) in request'), {
      headers: { authorization: 'Bearer HEADER_SECRET' },
    });
    const err = (await collect(a.chat(req())).catch((e: unknown) => e)) as NeoError;
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.headers.get('authorization')).toBe('Bearer HEADER_SECRET');
    expect(err).toBeInstanceOf(NeoError);
    expect(err).toMatchObject({ code: 'provider_error', retryable: false });
    expect(err.message).toContain('Anthropic error: bad authorization');
    expect(err.message).not.toContain('HEADER_SECRET');
    expect(err.message).not.toContain('Bearer HEADER_SECRET');
  });

  it('network failures are retried, then reported as retryable provider_error', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const sleep = recordingSleep();
    const a = new AnthropicAdapter(config(), { fetch: f, sleep });
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_error', retryable: true });
    expect(f.calls).toHaveLength(3);
  });

  it('abort during the retry backoff ends with cancelled', async () => {
    const ac = new AbortController();
    const f = fakeFetch(apiError(500, 'boom', 'api_error'));
    const a = new AnthropicAdapter(config(), {
      fetch: f,
      sleep: () => {
        ac.abort();
        return new Promise(() => {});
      },
    });
    await expect(collect(a.chat(req({ signal: ac.signal })))).rejects.toMatchObject({ code: 'cancelled' });
  });
});

// ───────────────────────────── keys, models, test() ─────────────────────────────

describe('Anthropic keys, listModels, test()', () => {
  it('does not reflect malformed model data or invalid model-entry errors', async () => {
    const f = fakeFetch([
      () => new Response(KEY, { headers: { 'Content-Type': 'application/json' } }),
      () => jsonResponse({ data: [{ id: {} }], has_more: false }),
    ]);
    const a = new AnthropicAdapter(config(), { fetch: f });
    const error = await a.listModels().catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'provider_error', message: 'Anthropic returned invalid model data.' });
    expect(error).not.toHaveProperty('cause');
    expect(await a.listModels()).toEqual([]);
  });

  it('rejects credential echoes in model ids', async () => {
    const f = fakeFetch(() => jsonResponse({ data: [{ id: KEY }], has_more: false }));
    const a = new AnthropicAdapter(config(), { fetch: f });
    await expect(a.listModels()).rejects.toMatchObject({ code: 'provider_error', message: 'Anthropic returned invalid model data.' });
  });

  it('a missing key is provider_auth at call time, without a network call', async () => {
    const f = fakeFetch(simpleReply);
    const a = new AnthropicAdapter(config({ apiKey: undefined }), { fetch: f });
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_auth' });
    await expect(a.listModels()).rejects.toMatchObject({ code: 'provider_auth' });
    expect(f.calls).toHaveLength(0);
    expect((await a.test()).ok).toBe(false);
  });

  it('resolves apiKeySecret at call time (a key saved later is picked up)', async () => {
    const secrets: Record<string, string> = {};
    const f = fakeFetch([simpleReply]);
    const a = new AnthropicAdapter(config({ apiKey: undefined, apiKeySecret: 'provider:anthropic' }), {
      fetch: f,
      resolveSecret: (n) => secrets[n],
    });
    await expect(collect(a.chat(req()))).rejects.toMatchObject({ code: 'provider_auth' });
    secrets['provider:anthropic'] = 'sk-ant-later';
    await collect(a.chat(req()));
    expect(f.calls[0]!.headers.get('x-api-key')).toBe('sk-ant-later');
    expect(a.config.apiKey).toBeUndefined();
  });

  it('listModels maps limits and capabilities, skips retired models and honors the signal', async () => {
    const page = {
      data: [
        {
          type: 'model',
          id: 'claude-opus-5-5',
          display_name: 'Claude Opus 5.5',
          created_at: '2026-09-01T00:00:00Z',
          lifecycle: 'active',
          max_input_tokens: 1_000_000,
          max_tokens: 128_000,
          capabilities: { image_input: { supported: true }, thinking: { supported: true, types: { adaptive: { supported: true } } } },
        },
        {
          type: 'model',
          id: 'claude-text-only',
          display_name: 'Text only',
          created_at: '2026-01-01T00:00:00Z',
          lifecycle: 'deprecated',
          max_input_tokens: 200_000,
          max_tokens: 8_000,
          capabilities: { image_input: { supported: false }, thinking: { supported: false, types: {} } },
        },
        { type: 'model', id: 'claude-2', display_name: 'Claude 2', created_at: '2023-01-01T00:00:00Z', lifecycle: 'retired', max_input_tokens: null, max_tokens: null, capabilities: null },
      ],
      has_more: false,
      first_id: 'claude-opus-5-5',
      last_id: 'claude-2',
    };
    const f = fakeFetch(() => jsonResponse(page));
    const a = new AnthropicAdapter(config(), { fetch: f });
    const ac = new AbortController();
    const models = await a.listModels(ac.signal);
    expect(f.calls[0]!.url).not.toContain('signal');
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-text-only']);
    expect(models[0]).toMatchObject({
      provider: 'anthropic',
      label: 'Claude Opus 5.5',
      capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, vision: true, reasoning: true, tools: true, embeddings: false },
    });
    expect(models[1]!.capabilities).toMatchObject({ vision: false, reasoning: false, contextWindow: 200_000, maxOutputTokens: 8_000 });
    expect((a as ProviderAdapter).embed).toBeUndefined();
  });

  it('static capabilities know current model limits', () => {
    const a = new AnthropicAdapter(config());
    expect(a.capabilities('claude-opus-5-5')).toMatchObject({ reasoning: true, vision: true, contextWindow: 1_000_000, maxOutputTokens: 128_000 });
    expect(a.capabilities('claude-haiku-4-5')).toMatchObject({ reasoning: false, contextWindow: 200_000, maxOutputTokens: 64_000 });
  });

  it('test() reports ok with model ids', async () => {
    const f = fakeFetch(() => jsonResponse({ data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Opus', created_at: '', lifecycle: 'active', max_input_tokens: 1, max_tokens: 1, capabilities: null }], has_more: false }));
    const a = new AnthropicAdapter(config(), { fetch: f });
    const result = await a.test();
    expect(result).toMatchObject({ ok: true, models: ['claude-opus-5-5'] });
  });

  it('isLocal follows config.local, then the base URL', () => {
    expect(new AnthropicAdapter(config()).isLocal).toBe(false);
    expect(new AnthropicAdapter(config({ baseUrl: 'http://127.0.0.1:8080' })).isLocal).toBe(true);
    expect(new AnthropicAdapter(config({ baseUrl: 'http://127.0.0.1:8080', local: false })).isLocal).toBe(false);
  });
});
