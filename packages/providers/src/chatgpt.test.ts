import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectChat, type ChatRequest, type ProviderConfig, type ToolSpec } from '@neo/protocol';
import { ChatGPTAdapter, createProvider } from './index.js';

const TOKEN = 'chatgpt-access-secret-123456';
const config: ProviderConfig = { id: 'chatgpt', kind: 'chatgpt', enabled: true };
const request: ChatRequest = { model: 'gpt-5.2', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }] };
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const completed = (extra: Record<string, unknown> = {}) => ({ type: 'response.completed', response: { status: 'completed', ...extra } });

describe('ChatGPT Responses API with a loopback fake', () => {
  let server: Server;
  let base: string;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  let calls: { url: string; authorization: string | undefined; body: Record<string, unknown> | undefined }[];
  let unauthorized: ReturnType<typeof vi.fn>;
  let adapter: ChatGPTAdapter;

  const stream = (...events: unknown[]) => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(frame).join(''));
    };
  };
  const reject = (status: number, code: string) => {
    handler = (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code, message: `Unsafe upstream text ${TOKEN}` } }));
    };
  };

  beforeEach(async () => {
    calls = [];
    unauthorized = vi.fn();
    handler = (_req, res) => res.end(frame(completed()));
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        calls.push({ url: req.url ?? '', authorization: req.headers.authorization, body: body ? JSON.parse(body) as Record<string, unknown> : undefined });
        handler(req, res);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    base = `http://127.0.0.1:${address.port}`;
    const fetchLocal: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.openai.com');
      expect(url.pathname).not.toContain('backend-api');
      return fetch(`${base}${url.pathname}`, init);
    };
    adapter = new ChatGPTAdapter(config, { fetch: fetchLocal, getChatGPTAccessToken: async id => {
      expect(id).toBe('chatgpt');
      return TOKEN;
    }, onChatGPTUnauthorized: unauthorized });
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('uses Responses, stream:true and store:false without forbidden generation parameters', async () => {
    stream({ type: 'response.output_text.delta', delta: 'Hi' }, completed());
    const result = await collectChat(adapter.chat({ ...request, system: 'Be useful.', temperature: 0.5, maxTokens: 10, tools: [{ name: 'weather', description: 'Weather', inputSchema: { type: 'object' } }], toolChoice: 'auto', reasoning: 'high' }));
    expect(result.text).toBe('Hi');
    expect(result.stopReason).toBe('end');
    expect(calls[0]).toMatchObject({ url: '/v1/responses', authorization: `Bearer ${TOKEN}` });
    expect(calls[0]?.body).toMatchObject({ model: 'gpt-5.2', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }], instructions: 'Be useful.', stream: true, store: false, reasoning: { effort: 'high' }, tools: [{ type: 'function', name: 'weather', description: 'Weather', parameters: { type: 'object' }, strict: false }], tool_choice: 'auto' });
    for (const field of ['temperature', 'max_output_tokens', 'max_tokens', 'max_completion_tokens']) expect(calls[0]?.body).not.toHaveProperty(field);
    expect(JSON.stringify(adapter.config)).not.toContain(TOKEN);
    expect(adapter.config).toBe(config);
  });

  it('omits reasoning controls for non-reasoning fallback models even when core sends off', async () => {
    stream(completed());
    await collectChat(adapter.chat({ ...request, model: 'gpt-4o', reasoning: 'off' }));
    expect(calls[0]?.body).not.toHaveProperty('reasoning');
    expect(calls[0]?.body).not.toHaveProperty('include');
    expect(calls[0]?.body).toMatchObject({ model: 'gpt-4o', store: false, stream: true });
  });

  it('normalizes fragmented function calls, reasoning replay data and usage without duplicate tools', async () => {
    const tool = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'weather', arguments: '{"city":"London"}', status: 'completed' };
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Thinking' }], encrypted_content: 'opaque' };
    stream(
      { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
      { type: 'response.output_item.done', item: reasoning },
      { type: 'response.output_item.added', output_index: 1, item: { ...tool, arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"London"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: tool.arguments },
      { type: 'response.output_item.done', item: tool },
      completed({ output: [reasoning, tool], usage: { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 5 } } }),
    );
    const result = await collectChat(adapter.chat(request));
    expect(result.reasoning).toBe('Thinking');
    expect(result.reasoningParts).toEqual([{ type: 'reasoning', text: 'Thinking', provider: 'chatgpt', model: 'gpt-5.2', data: reasoning }]);
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'weather', input: { city: 'London' }, data: tool }]);
    expect(result.usage).toEqual({ inputTokens: 70, outputTokens: 25, cacheReadTokens: 30, reasoningTokens: 5 });
    expect(result.stopReason).toBe('tool_use');

    stream(completed());
    await collectChat(adapter.chat({ ...request, messages: [
      { role: 'assistant', parts: [result.reasoningParts[0]!, { type: 'text', text: 'Checking' }, { type: 'tool_call', ...result.toolCalls[0]!, provider: 'chatgpt' }] },
      { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'call_1', name: 'weather', output: { sunny: true } }] },
    ] }));
    expect(calls[1]?.body?.['input']).toEqual([reasoning, { role: 'assistant', content: [{ type: 'input_text', text: 'Checking' }] }, tool, { type: 'function_call_output', call_id: 'call_1', output: '{"sunny":true}' }]);
  });

  it('drops reasoning replay data from another provider or model', async () => {
    stream(completed());
    await collectChat(adapter.chat({ ...request, messages: [{ role: 'assistant', parts: [
      { type: 'reasoning', text: 'Other provider', provider: 'openai', model: request.model, data: { type: 'reasoning', encrypted_content: 'wrong-provider' } },
      { type: 'reasoning', text: 'Other model', provider: 'chatgpt', model: 'gpt-5', data: { type: 'reasoning', encrypted_content: 'wrong-model' } },
      { type: 'text', text: 'Answer' },
    ] }] }));
    expect(calls[0]?.body?.['input']).toEqual([{ role: 'assistant', content: [{ type: 'input_text', text: 'Answer' }] }]);
  });

  it('replays core-persisted ChatGPT parts for an instance whose id differs from its kind', async () => {
    const second = new ChatGPTAdapter({ ...config, id: 'chatgpt-2', baseUrl: `${base}/v1` }, { getChatGPTAccessToken: async () => TOKEN });
    const reasoning = { type: 'reasoning', id: 'rs_2', summary: [{ type: 'summary_text', text: 'Think' }], encrypted_content: 'replay-on-second-instance' };
    const tool = { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'go', arguments: '{}', status: 'completed' };
    stream({ type: 'response.output_item.done', item: reasoning }, { type: 'response.output_item.done', item: tool }, completed());
    const result = await collectChat(second.chat(request));
    expect(result.reasoningParts[0]?.provider).toBe('chatgpt');
    stream(completed());
    await collectChat(second.chat({ ...request, messages: [
      { role: 'assistant', parts: [{ type: 'reasoning', text: 'Think', provider: 'chatgpt', model: request.model, data: reasoning }, { type: 'tool_call', id: 'call_2', name: 'go', input: {}, provider: 'chatgpt', data: tool }] },
      { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'call_2', name: 'go', output: 'Done' }] },
    ] }));
    expect(calls[1]?.body?.['input']).toEqual([reasoning, tool, { type: 'function_call_output', call_id: 'call_2', output: 'Done' }]);
  });

  it('can finish calls from the final output when item.done is absent', async () => {
    stream({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'go', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"x":1}' },
      completed({ output: [{ type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'go', arguments: '{"x":1}' }] }));
    expect((await collectChat(adapter.chat(request))).toolCalls).toHaveLength(1);
  });

  it('abort after first tool_call in completion batch is honoured', async () => {
    const ac = new AbortController();
    stream(completed({ output: [
      { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call', id: 'fc_2', call_id: 'c2', name: 'get_weather', arguments: '{"city":"Rome"}' },
    ] }));
    const iterator = adapter.chat({ ...request, signal: ac.signal, tools: [{ name: 'get_weather', description: 'Weather', inputSchema: { type: 'object' } }] })[Symbol.asyncIterator]();
    let event = await iterator.next();
    while (!event.done && event.value.type !== 'tool_call') event = await iterator.next();
    expect(event.value).toMatchObject({ type: 'tool_call', id: 'c1', input: { city: 'Paris' } });
    ac.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('finishes fragmented calls from accumulated arguments on completion', async () => {
    stream({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'go', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"x":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '1}' }, completed());
    expect((await collectChat(adapter.chat(request))).toolCalls).toEqual([{ id: 'c1', name: 'go', input: { x: 1 }, data: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'go', arguments: '' } }]);
  });

  it('lists only visibility:list models by slug with text-only capabilities', async () => {
    handler = (_req, res) => res.end(JSON.stringify({ data: [
      { id: 'opaque-id', slug: 'gpt-5.2', visibility: 'list', architecture: { output_modalities: ['text', 'image', 'audio'] } },
      { id: 'hidden', slug: 'gpt-hidden', visibility: 'hidden' }, { id: 'missing', slug: 'gpt-missing' },
    ] }));
    const models = await adapter.listModels();
    expect(calls[0]).toMatchObject({ url: '/v1/models', authorization: `Bearer ${TOKEN}` });
    expect(models.map(model => model.id)).toEqual(['gpt-5.2']);
    expect(models[0]?.capabilities).toMatchObject({ text: true, tools: true, vision: false, embeddings: false, speechToText: false, textToSpeech: false, image: false, video: false });
    expect(adapter).not.toHaveProperty('embed');
  });

  it('never reflects malformed model payloads or credential-bearing slugs', async () => {
    for (const data of [`{${TOKEN}`, JSON.stringify({ data: [{ slug: TOKEN, visibility: 'list' }] })]) {
      handler = (_req, res) => res.end(data);
      const error = await adapter.listModels().catch((value: unknown) => value);
      expect(error).toMatchObject({ code: 'provider_error' });
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }
  });

  it.each([
    [429, 'subscription_sharing_usage_limit_exceeded', 'rate_limited', "You've reached the weekly limit you set for NEO in ChatGPT.", false],
    [503, 'subscription_sharing_usage_unavailable', 'provider_error', 'ChatGPT is temporarily unavailable. Try again later.', true],
    [403, 'subscription_sharing_user_not_eligible', 'provider_auth', 'Needs ChatGPT Plus or Pro.', false],
    [401, 'subscription_sharing_invalid_user', 'provider_auth', 'Disconnected; sign in again.', false],
  ])('maps HTTP %i %s to safe typed guidance', async (status, reason, code, message, retryable) => {
    reject(status, reason);
    const error = await collectChat(adapter.chat(request)).catch((value: unknown) => value);
    expect(error).toMatchObject({ code, message, retryable, details: { reason, status } });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });

  it.each([
    ['subscription_sharing_usage_limit_exceeded', 'rate_limited', "You've reached the weekly limit you set for NEO in ChatGPT."],
    ['subscription_sharing_usage_unavailable', 'provider_error', 'ChatGPT is temporarily unavailable. Try again later.'],
    ['subscription_sharing_user_not_eligible', 'provider_auth', 'Needs ChatGPT Plus or Pro.'],
    ['subscription_sharing_invalid_user', 'provider_auth', 'Disconnected; sign in again.'],
  ])('maps mid-stream response.failed %s', async (reason, code, message) => {
    stream({ type: 'response.output_text.delta', delta: 'Partial' }, { type: 'response.failed', response: { error: { code: reason, message: TOKEN } } });
    const error = await collectChat(adapter.chat(request)).catch((value: unknown) => value);
    expect(error).toMatchObject({ code, message, details: { reason } });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(unauthorized).toHaveBeenCalledTimes(reason.endsWith('invalid_user') ? 1 : 0);
  });

  it('sanitizes unknown errors and does not use the optional logger', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const safe = new ChatGPTAdapter({ ...config, baseUrl: `${base}/v1` }, { logger, getChatGPTAccessToken: async () => TOKEN });
    reject(502, TOKEN);
    const error = await collectChat(safe.chat(request)).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'provider_error', message: 'ChatGPT could not complete the request. Try again later.', details: { status: 502 } });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(Object.values(logger).every(log => log.mock.calls.length === 0)).toBe(true);
  });

  it.each(['http', 'stream'])('passes the exact failing token after a concurrent token replacement (%s)', async mode => {
    let current = TOKEN;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    let finish!: () => void;
    handler = (_req, res) => {
      if (calls.at(-1)?.body?.['model'] === request.model) {
        if (mode === 'stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(frame({ type: 'response.output_text.delta', delta: 'Started' }));
        }
        finish = () => {
          if (mode === 'http') {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'subscription_sharing_invalid_user' } }));
          } else res.end(frame({ type: 'response.failed', response: { error: { code: 'subscription_sharing_invalid_user' } } }));
        };
        started();
      } else res.end(frame(completed()));
    };
    const rotating = new ChatGPTAdapter({ ...config, baseUrl: `${base}/v1` }, { getChatGPTAccessToken: async () => current, onChatGPTUnauthorized: unauthorized });
    const old = collectChat(rotating.chat(request)).catch((value: unknown) => value);
    await pending;
    current = `${TOKEN}-replacement`;
    await collectChat(rotating.chat({ ...request, model: 'gpt-5.3' }));
    finish();
    expect(await old).toMatchObject({ code: 'provider_auth' });
    expect(calls.map(call => call.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}-replacement`]);
    expect(unauthorized).toHaveBeenCalledExactlyOnceWith('chatgpt', TOKEN);
  });

  it('needs sign-in when the credential manager is absent', async () => {
    const empty = createProvider(config);
    await expect(collectChat(empty.chat(request))).rejects.toMatchObject({ code: 'provider_auth', message: 'Disconnected; sign in again.' });
    expect(calls).toHaveLength(0);
  });

  it('enforces text-only inputs and excludes hosted tools', async () => {
    await expect(collectChat(adapter.chat({ ...request, messages: [{ role: 'user', parts: [{ type: 'image', url: 'https://example.invalid/image.png', mediaType: 'image/png' }] }] }))).rejects.toMatchObject({ code: 'bad_request' });
    await expect(collectChat(adapter.chat({ ...request, tools: [{ name: 'code_interpreter', description: 'Hosted tool', inputSchema: {}, type: 'code_interpreter' } as ToolSpec] }))).rejects.toMatchObject({ code: 'bad_request' });
    expect(calls).toHaveLength(0);
  });

  it('maps refusal and incomplete outputs and rejects premature EOF', async () => {
    stream({ type: 'response.refusal.delta', delta: "I can't." }, completed());
    expect(await collectChat(adapter.chat(request))).toMatchObject({ text: "I can't.", stopReason: 'refusal' });
    stream({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } });
    expect((await collectChat(adapter.chat(request))).stopReason).toBe('max_tokens');
    stream({ type: 'response.output_text.delta', delta: 'Cut off' });
    await expect(collectChat(adapter.chat(request))).rejects.toMatchObject({ code: 'provider_error', retryable: true });
  });

  it('supports JSON extraction with a Responses format and honors cancellation', async () => {
    stream(completed());
    await collectChat(adapter.chat({ ...request, responseFormat: 'json' }));
    expect(calls[0]?.body).toMatchObject({ instructions: 'Respond with a single JSON object only.', text: { format: { type: 'json_object' } } });
    const signal = AbortSignal.abort();
    await expect(collectChat(adapter.chat({ ...request, signal }))).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toHaveLength(1);
  });

  it('rejects non-public production endpoints including backend-api', () => {
    expect(() => new ChatGPTAdapter({ ...config, baseUrl: 'https://chatgpt.com/backend-api' })).toThrow('public OpenAI API');
  });
});

describe('ChatGPT per-yield batch cancellation', () => {
  const first = { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'get_weather', arguments: '{"city":"Paris"}' };
  const second = { type: 'function_call', id: 'fc_2', call_id: 'c2', name: 'get_weather', arguments: '{"city":"Rome"}' };
  const search = { type: 'web_search_call', id: 'search_1' };
  const usage = { input_tokens: 10, output_tokens: 5 };

  it.each([
    { name: 'completed output tool-call batch', events: [completed({ output: [first, second] })], after: { type: 'tool_call', id: 'c1' }, nativeSearch: false },
    { name: 'accumulated tool-call batch', events: [
      { type: 'response.output_item.added', item: first },
      { type: 'response.output_item.added', item: second },
      completed(),
    ], after: { type: 'tool_call', id: 'c1' }, nativeSearch: false },
    { name: 'completed output replay batch', events: [completed({ output: [search, { ...search, id: 'search_2' }] })], after: { type: 'provider_part', part: { data: { id: 'search_1' } } }, nativeSearch: true },
    { name: 'native-search replay before the final aggregate', events: [completed({ output: [search] })], after: { type: 'provider_part', part: { data: { id: 'search_1' } } }, nativeSearch: true },
    { name: 'sources before usage', events: [completed({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer', annotations: [{ type: 'url_citation', url: 'https://example.com', title: 'Example' }] }] }], usage })], after: { type: 'sources' }, nativeSearch: false },
    { name: 'usage before done', events: [completed({ usage })], after: { type: 'usage' }, nativeSearch: false },
  ])('abort after $name is honoured', async ({ events, after, nativeSearch }) => {
    const ac = new AbortController();
    const adapter = new ChatGPTAdapter(config, {
      fetch: async () => new Response(events.map(frame).join(''), { headers: { 'content-type': 'text/event-stream' } }),
      getChatGPTAccessToken: async () => TOKEN,
    });
    const iterator = adapter.chat({ ...request, signal: ac.signal, ...(nativeSearch ? { webSearch: {} } : {}), tools: [{ name: 'get_weather', description: 'Weather', inputSchema: { type: 'object' } }] })[Symbol.asyncIterator]();
    let event = await iterator.next();
    while (!event.done && event.value.type !== after.type) event = await iterator.next();
    expect(event.value).toMatchObject(after);
    ac.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'cancelled' });
  });
});
