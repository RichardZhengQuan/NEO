import { describe, expect, it } from 'vitest';
import { collectChat, type ChatMessage, type ChatRequest, type ContentPart, type ProviderConfig } from '@neo/protocol';
import { AnthropicAdapter, ChatGPTAdapter, GeminiAdapter, OpenAIAdapter, supportsOpenAIWebSearch } from './index.js';
import { toAnthropicMessages } from './anthropic.js';
import { collect, dataFrames, fakeFetch, jsonResponse, ofType, sseResponse, textOfEvents, typedFrames } from './testing/http.js';

const key = 'fake-search-key-123456';
const source = { title: 'Example', url: 'https://example.test/article' };
const tools = [{ name: 'get_time', description: 'Time', inputSchema: { type: 'object' } }];
const config = (kind: ProviderConfig['kind'], extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: kind, kind, apiKey: key, enabled: true, ...extra });
const request = (model: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({ model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'Look it up' }] }], ...extra });
const anthropicFrames = (frames: ({ type: string } & Record<string, unknown>)[]) => typedFrames(frames);
const openAIReply = () => sseResponse(dataFrames([
  { choices: [{ delta: { content: 'Answer' }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]',
]));
const geminiReply = () => sseResponse(dataFrames([{ candidates: [{ content: { parts: [{ text: 'Answer' }] }, finishReason: 'STOP' }] }]));
const anthropicReply = () => sseResponse(anthropicFrames([
  { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]));
const chatGPTReply = () => sseResponse(dataFrames([{ type: 'response.output_text.delta', delta: 'Answer' }, { type: 'response.completed', response: { status: 'completed' } }]));

describe('native web-search capabilities and request fields', () => {
  it.each([
    ['gpt-4o-search-preview', true], ['gpt-4o-mini-search-preview', true], ['gpt-5-search-api', true],
    ['gpt-5', false], ['gpt-4o', false], ['o3', false], ['vendor/gpt-4o-search-preview', false],
  ])('keeps OpenAI Chat Completions model support in one predicate: %s', (model, supported) => {
    expect(supportsOpenAIWebSearch(model as string)).toBe(supported);
  });

  it('advertises native search only on supported models and official endpoints', () => {
    expect(new AnthropicAdapter(config('anthropic')).capabilities('claude-sonnet-5-5').nativeWebSearch).toBe(true);
    expect(new AnthropicAdapter(config('anthropic')).capabilities('claude-2.1').nativeWebSearch).toBe(false);
    expect(new AnthropicAdapter(config('anthropic', { baseUrl: 'https://custom.test' })).capabilities('claude-sonnet-5-5').nativeWebSearch).toBe(false);
    expect(new GeminiAdapter(config('gemini')).capabilities('gemini-2.5-flash').nativeWebSearch).toBe(true);
    expect(new GeminiAdapter(config('gemini')).capabilities('gemini-1.5-flash').nativeWebSearch).toBe(false);
    expect(new GeminiAdapter(config('gemini')).capabilities('gemini-2.5-flash-image').nativeWebSearch).toBe(false);
    expect(new GeminiAdapter(config('gemini', { baseUrl: 'https://custom.test' })).capabilities('gemini-2.5-flash').nativeWebSearch).toBe(false);
    expect(new ChatGPTAdapter(config('chatgpt')).capabilities('gpt-5').nativeWebSearch).toBe(true);
    expect(new OpenAIAdapter(config('openai')).capabilities('gpt-4o-search-preview').nativeWebSearch).toBe(true);
    expect(new OpenAIAdapter(config('openai')).capabilities('gpt-5').nativeWebSearch).toBe(false);
    expect(new OpenAIAdapter(config('openai', { baseUrl: 'https://custom.test/v1' })).capabilities('gpt-4o-search-preview').nativeWebSearch).toBe(false);
    expect(new OpenAIAdapter(config('openai-compatible', { baseUrl: 'https://openrouter.ai/api/v1/' })).capabilities('anthropic/claude-sonnet-5-5').nativeWebSearch).toBe(true);
    for (const baseUrl of ['https://custom.test/v1', 'https://openrouter.ai.evil.test/api/v1', 'https://openrouter.ai/api/v1/proxy']) {
      expect(new OpenAIAdapter(config('openai-compatible', { baseUrl })).capabilities('gpt-4o-search-preview').nativeWebSearch).toBe(false);
    }
    expect(new OpenAIAdapter(config('ollama')).capabilities('gpt-4o-search-preview').nativeWebSearch).toBe(false);
  });

  it('adds the Anthropic server tool alongside function tools only when requested', async () => {
    const fetch = fakeFetch(anthropicReply);
    const adapter = new AnthropicAdapter(config('anthropic'), { fetch });
    await collect(adapter.chat(request('claude-sonnet-5-5', { tools, webSearch: { maxUses: 2 } })));
    expect(fetch.calls[0]!.body!['tools']).toEqual([
      { name: 'get_time', description: 'Time', input_schema: { type: 'object' }, eager_input_streaming: true },
      { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
    ]);
    await collect(adapter.chat(request('claude-sonnet-5-5')));
    expect(fetch.calls[1]!.body).not.toHaveProperty('tools');
  });

  it('adds google_search alongside Gemini function declarations only when requested', async () => {
    const fetch = fakeFetch(geminiReply);
    const adapter = new GeminiAdapter(config('gemini'), { fetch });
    await collect(adapter.chat(request('gemini-2.5-flash', { tools, webSearch: {} })));
    expect(fetch.calls[0]!.body!['tools']).toEqual([{ functionDeclarations: [{ name: 'get_time', description: 'Time' }] }, { google_search: {} }]);
    await collect(adapter.chat(request('gemini-2.5-flash')));
    expect(fetch.calls[1]!.body).not.toHaveProperty('tools');
  });

  it('adds web_search_options only on OpenAI search models, and plugins only on OpenRouter', async () => {
    const fetch = fakeFetch(openAIReply);
    const adapter = new OpenAIAdapter(config('openai'), { fetch });
    await collect(adapter.chat(request('gpt-4o-search-preview', { webSearch: {} })));
    expect(fetch.calls[0]!.body!['web_search_options']).toEqual({});
    expect(fetch.calls[0]!.body).not.toHaveProperty('plugins');
    await collect(adapter.chat(request('gpt-4o-search-preview')));
    await collect(adapter.chat(request('gpt-5', { webSearch: {} })));
    expect(fetch.calls[1]!.body).not.toHaveProperty('web_search_options');
    expect(fetch.calls[2]!.body).not.toHaveProperty('web_search_options');
    const router = new OpenAIAdapter(config('openai-compatible', { baseUrl: 'https://openrouter.ai/api/v1' }), { fetch });
    await collect(router.chat(request('anthropic/claude-sonnet-5-5', { webSearch: {} })));
    expect(fetch.calls[3]!.body!['plugins']).toEqual([{ id: 'web' }]);
    expect(fetch.calls[3]!.body).not.toHaveProperty('web_search_options');
    await collect(router.chat(request('anthropic/claude-sonnet-5-5')));
    expect(fetch.calls[4]!.body).not.toHaveProperty('plugins');
    const custom = new OpenAIAdapter(config('openai-compatible', { baseUrl: 'https://custom.test/v1' }), { fetch });
    await collect(custom.chat(request('gpt-4o-search-preview', { webSearch: {} })));
    expect(fetch.calls[5]!.body).not.toHaveProperty('plugins');
    expect(fetch.calls[5]!.body).not.toHaveProperty('web_search_options');
  });

  it.each(['gpt-4o-search-preview', 'gpt-4o-mini-search-preview', 'gpt-4o-search-preview-2025-03-11', 'gpt-4o-mini-search-preview-2025-03-11'])(
    'omits unsupported search-preview function, sampling and JSON fields on %s with search on or off', async model => {
      const fetch = fakeFetch(openAIReply);
      const adapter = new OpenAIAdapter(config('openai'), { fetch });
      expect(adapter.capabilities(model)).toMatchObject({ nativeWebSearch: true, tools: false });
      for (const webSearch of [{}, undefined]) {
        await collect(adapter.chat(request(model, { tools, toolChoice: 'none', temperature: 0.5, responseFormat: 'json',
          ...(webSearch ? { webSearch } : {}) })));
        const body = fetch.calls.at(-1)!.body!;
        for (const field of ['tools', 'tool_choice', 'temperature', 'response_format']) expect(body).not.toHaveProperty(field);
        if (webSearch) expect(body['web_search_options']).toEqual({});
        else expect(body).not.toHaveProperty('web_search_options');
        expect(body['messages']).toContainEqual({ role: 'system', content: 'Respond with a single JSON object only.' });
      }
    },
  );

  it('preserves general GPT function/sampling/JSON fields and OpenRouter function/sampling fields', async () => {
    const fetch = fakeFetch(openAIReply);
    const general = new OpenAIAdapter(config('openai'), { fetch });
    const router = new OpenAIAdapter(config('openai-compatible', { baseUrl: 'https://openrouter.ai/api/v1' }), { fetch });
    const custom = new OpenAIAdapter(config('openai', { baseUrl: 'https://custom.test/v1' }), { fetch });
    expect(general.capabilities('gpt-4o').tools).toBe(true);
    expect(router.capabilities('gpt-4o-search-preview').tools).toBe(true);
    expect(custom.capabilities('gpt-4o-search-preview').tools).toBe(true);
    await collect(general.chat(request('gpt-4o', { tools, toolChoice: 'auto', temperature: 0.5, responseFormat: 'json' })));
    await collect(router.chat(request('gpt-4o-search-preview', { tools, toolChoice: 'auto', temperature: 0.5, webSearch: {} })));
    await collect(custom.chat(request('gpt-4o-search-preview', { tools, toolChoice: 'auto', temperature: 0.5, responseFormat: 'json' })));
    for (const call of fetch.calls) {
      expect(call.body).toMatchObject({ temperature: 0.5, tool_choice: 'auto', tools: [
        { type: 'function', function: { name: 'get_time', description: 'Time', parameters: { type: 'object' } } },
      ] });
    }
    expect(fetch.calls[0]!.body!['response_format']).toEqual({ type: 'json_object' });
    expect(fetch.calls[1]!.body!['plugins']).toEqual([{ id: 'web' }]);
    expect(fetch.calls[2]!.body!['response_format']).toEqual({ type: 'json_object' });
  });

  it('keeps the official search-preview function restriction when model metadata advertises tools', async () => {
    const fetch = fakeFetch(() => jsonResponse({ data: [{ id: 'gpt-4o-search-preview', supported_parameters: ['tools'] }] }));
    const adapter = new OpenAIAdapter(config('openai'), { fetch });
    expect((await adapter.listModels())[0]!.capabilities).toMatchObject({ tools: false, nativeWebSearch: true });
    expect(adapter.capabilities('gpt-4o-search-preview').tools).toBe(false);
  });

  it('adds the ChatGPT Responses hosted tool alongside function tools only when requested', async () => {
    const fetch = fakeFetch(chatGPTReply);
    const adapter = new ChatGPTAdapter(config('chatgpt'), { fetch, getChatGPTAccessToken: async () => key });
    await collect(adapter.chat(request('gpt-5', { tools, webSearch: {} })));
    expect(fetch.calls[0]!.body!['tools']).toEqual([
      { type: 'function', name: 'get_time', description: 'Time', parameters: { type: 'object' }, strict: false },
      { type: 'web_search' },
    ]);
    await collect(adapter.chat(request('gpt-5')));
    expect(fetch.calls[1]!.body).not.toHaveProperty('tools');
  });
});

describe('native source mapping and replay', () => {
  it('keeps Anthropic upstream block order when NEO function calls are deferred, including thinking and tool continuation', async () => {
    const thinking = { type: 'thinking', thinking: 'Think', signature: 'sig' };
    const call = { type: 'tool_use', id: 'neo_1', name: 'get_time', input: { timezone: 'UTC' } };
    const search = { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'latest' } };
    const result = { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', ...source, encrypted_content: 'opaque' }] };
    const text = { type: 'text', text: 'Answer', citations: [{ type: 'web_search_result_location', ...source, cited_text: 'Fact', encrypted_index: 'index' }] };
    const fetch = fakeFetch([
      () => sseResponse(anthropicFrames([
        { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { ...thinking, thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Think' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { ...call, input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"timezone":"UTC"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: search },
        { type: 'content_block_stop', index: 2 },
        { type: 'content_block_start', index: 3, content_block: result },
        { type: 'content_block_stop', index: 3 },
        { type: 'content_block_start', index: 4, content_block: text },
        { type: 'content_block_stop', index: 4 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ])), anthropicReply,
    ]);
    const adapter = new AnthropicAdapter(config('anthropic'), { fetch });
    const first = request('claude-sonnet-5-5', { tools, webSearch: {} });
    const events = await collect(adapter.chat(first));
    expect(ofType(events, 'tool_call')).toEqual([{ type: 'tool_call', id: 'neo_1', name: 'get_time', input: { timezone: 'UTC' } }]);
    const parts: ContentPart[] = events.flatMap(event => event.type === 'text' ? [{ type: 'text', text: event.text } as ContentPart]
      : event.type === 'provider_part' || event.type === 'reasoning_part' ? [event.part]
        : event.type === 'tool_call' ? [{ type: 'tool_call', id: event.id, name: event.name, input: event.input } as ContentPart] : []);
    const messages: ChatMessage[] = [...first.messages, { role: 'assistant', parts },
      { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'neo_1', name: 'get_time', output: '12:00' }] }];
    await collect(adapter.chat({ ...first, messages }));
    expect(fetch.calls[1]!.body!['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Look it up' }] },
      { role: 'assistant', content: [thinking, call, search, result, text] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'neo_1', content: '12:00' }] },
    ]);
    expect(toAnthropicMessages(messages, first.model, { dropThinking: true })[1]!.content).toEqual([call, search, result, text]);
  });

  it('maps Anthropic server search and citation deltas without producing a NEO tool call; replays the complete blocks', async () => {
    const serverCall = { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} };
    const searchResult = { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', ...source, encrypted_content: 'opaque' }] };
    const citation = { type: 'web_search_result_location', ...source, cited_text: 'Quoted fact', encrypted_index: 'index' };
    const fetch = fakeFetch([
      () => sseResponse(anthropicFrames([
        { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: serverCall },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"latest"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: searchResult },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '', citations: [] } },
        { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Answer' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ])), anthropicReply,
    ]);
    const adapter = new AnthropicAdapter(config('anthropic'), { fetch });
    const first = request('claude-sonnet-5-5', { webSearch: {} });
    const events = await collect(adapter.chat(first));
    expect(textOfEvents(events)).toBe('Answer');
    expect(ofType(events, 'tool_call')).toEqual([]);
    expect(ofType(events, 'sources')).toEqual([{ type: 'sources', items: [{ ...source, snippet: 'Quoted fact' }] }]);
    const parts: ContentPart[] = events.flatMap(event => event.type === 'text' ? [{ type: 'text', text: event.text } as ContentPart]
      : event.type === 'provider_part' ? [event.part] : []);
    expect(parts.filter(part => part.type === 'provider_part')).toHaveLength(1);
    const messages: ChatMessage[] = [...first.messages, { role: 'assistant', parts }, { role: 'user', parts: [{ type: 'text', text: 'More' }] }];
    await collect(adapter.chat({ ...first, messages }));
    expect((fetch.calls[1]!.body!['messages'] as { content: unknown[] }[])[1]!.content).toEqual([
      { ...serverCall, input: { query: 'latest' } }, searchResult, { type: 'text', text: 'Answer', citations: [citation] },
    ]);
    await collect(adapter.chat({ ...first, model: 'claude-haiku-4-5', messages }));
    expect((fetch.calls[2]!.body!['messages'] as { content: unknown[] }[])[1]!.content).toEqual([{ type: 'text', text: 'Answer' }]);
  });

  it('maps Anthropic citations supplied with an initial text block', async () => {
    const fetch = fakeFetch(() => sseResponse(anthropicFrames([
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Answer', citations: [{ type: 'web_search_result_location', ...source, cited_text: 'Fact', encrypted_index: 'index' }] } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ])));
    const result = await collectChat(new AnthropicAdapter(config('anthropic'), { fetch }).chat(request('claude-sonnet-5-5', { webSearch: {} })));
    expect(result.sources).toEqual([{ ...source, snippet: 'Fact' }]);
  });

  it.each(['openai', 'openai-compatible'] as const)('maps %s URL annotations from deltas and final messages, deduplicating and rejecting unsafe URLs', async kind => {
    const annotation = { type: 'url_citation', url_citation: { ...source, content: 'Fact' } };
    const fetch = fakeFetch(() => sseResponse(dataFrames([
      { choices: [{ delta: { content: 'Answer', annotations: [annotation, { type: 'url_citation', url_citation: { title: 'Unsafe', url: 'javascript:alert(1)' } }] } }] },
      { choices: [{ delta: {}, message: { annotations: [annotation] }, finish_reason: 'stop' }] }, '[DONE]',
    ])));
    const adapter = new OpenAIAdapter(config(kind, kind === 'openai-compatible' ? { baseUrl: 'https://openrouter.ai/api/v1' } : {}), { fetch });
    const result = await collectChat(adapter.chat(request('gpt-4o-search-preview', { webSearch: {} })));
    expect(result.text).toBe('Answer');
    expect(result.sources).toEqual([{ ...source, snippet: 'Fact' }]);
  });

  it('maps Gemini grounding chunks without treating them as user-authored text', async () => {
    const fetch = fakeFetch(() => sseResponse(dataFrames([{ candidates: [{
      content: { parts: [{ text: 'Answer' }] }, finishReason: 'STOP', groundingMetadata: {
        groundingChunks: [{ web: { uri: source.url, title: source.title } }, { web: { uri: source.url } }, { web: { uri: 'data:text/plain,bad', title: 'Bad' } }],
      },
    }] }])));
    const result = await collectChat(new GeminiAdapter(config('gemini'), { fetch }).chat(request('gemini-2.5-flash', { webSearch: {} })));
    expect(result.text).toBe('Answer');
    expect(result.sources).toEqual([source]);
    expect(result.toolCalls).toEqual([]);
  });

  it('maps ChatGPT search and URL citations, replaying final output order despite interleaved completion events', async () => {
    const search = { id: 'search_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'latest' } };
    const annotation = { type: 'url_citation', ...source, start_index: 0, end_index: 6 };
    const message = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Answer', annotations: [annotation] }] };
    const fetch = fakeFetch([
      () => sseResponse(dataFrames([
        { type: 'response.output_text.delta', delta: 'Answer' },
        { type: 'response.output_text.annotation.added', annotation },
        { type: 'response.output_item.done', item: message },
        { type: 'response.output_item.done', item: search },
        { type: 'response.completed', response: { status: 'completed', output: [search, message] } },
      ])), chatGPTReply,
    ]);
    const adapter = new ChatGPTAdapter(config('chatgpt'), { fetch, getChatGPTAccessToken: async () => key });
    const first = request('gpt-5', { webSearch: {} });
    const events = await collect(adapter.chat(first));
    expect(ofType(events, 'sources')).toEqual([{ type: 'sources', items: [source] }]);
    expect(ofType(events, 'tool_call')).toEqual([]);
    expect(ofType(events, 'provider_part')).toHaveLength(3);
    const parts: ContentPart[] = events.flatMap(event => event.type === 'text' ? [{ type: 'text', text: event.text } as ContentPart]
      : event.type === 'provider_part' ? [event.part] : []);
    const messages: ChatMessage[] = [...first.messages, { role: 'assistant', parts }, { role: 'user', parts: [{ type: 'text', text: 'More' }] }];
    await collect(adapter.chat({ ...first, messages }));
    expect(fetch.calls[1]!.body!['input']).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Look it up' }] }, search, message,
      { role: 'user', content: [{ type: 'input_text', text: 'More' }] },
    ]);
    await collect(adapter.chat({ ...first, model: 'gpt-4.1', messages }));
    expect(fetch.calls[2]!.body!['input']).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Look it up' }] },
      { role: 'assistant', content: [{ type: 'input_text', text: 'Answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'More' }] },
    ]);
  });

  it('collects ChatGPT annotations present only in the completed response', async () => {
    const fetch = fakeFetch(() => sseResponse(dataFrames([
      { type: 'response.output_text.delta', delta: 'Answer' },
      { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer', annotations: [{ type: 'url_citation', ...source }] }] }] } },
    ])));
    const result = await collectChat(new ChatGPTAdapter(config('chatgpt'), { fetch, getChatGPTAccessToken: async () => key }).chat(request('gpt-5', { webSearch: {} })));
    expect(result.sources).toEqual([source]);
  });
});

describe('ChatGPT hosted search rejection is remembered', () => {
  it.each(['http', 'stream'] as const)('surfaces one typed %s rejection and omits search on later turns even if requested', async transport => {
    const error = { code: 'unsupported_tool', param: 'tools[0]', message: `web_search is unavailable ${key}` };
    const fetch = fakeFetch([
      () => transport === 'http' ? jsonResponse({ error }, 400) : sseResponse(dataFrames([{ type: 'response.failed', response: { error } }])), chatGPTReply,
    ]);
    const adapter = new ChatGPTAdapter(config('chatgpt'), { fetch, getChatGPTAccessToken: async () => key });
    const chat = request('gpt-5', { webSearch: {} });
    await expect(collect(adapter.chat(chat))).rejects.toMatchObject({ code: 'search_unavailable', retryable: false, message: expect.stringContaining('disabled for this session') });
    expect(fetch.calls).toHaveLength(1);
    expect(adapter.capabilities('gpt-5').nativeWebSearch).toBe(false);
    expect(adapter.capabilities('gpt-4.1').nativeWebSearch).toBe(false);
    await collect(adapter.chat(chat));
    await collect(adapter.chat(chat));
    expect(fetch.calls).toHaveLength(3);
    expect(fetch.calls[1]!.body).not.toHaveProperty('tools');
    expect(fetch.calls[2]!.body).not.toHaveProperty('tools');
  });

  it('keeps search available after account or rate-limit failures', async () => {
    const fetch = fakeFetch(() => jsonResponse({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Limit' } }, 429));
    const adapter = new ChatGPTAdapter(config('chatgpt'), { fetch, getChatGPTAccessToken: async () => key });
    await expect(collect(adapter.chat(request('gpt-5', { webSearch: {} })))).rejects.toMatchObject({ code: 'rate_limited' });
    expect(adapter.capabilities('gpt-5').nativeWebSearch).toBe(true);
  });
});
