/** ChatGPT plan tokens use the public Responses API, with text-only inputs. */
import {
  NeoError,
  chatgptSubscriptionError,
  type ChatRequest,
  type ChatStreamEvent,
  type ModelCapabilities,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderTestResult,
  type StopReason,
  type Usage,
} from '@neo/protocol';
import type { ProviderOptions } from './index.js';
import { parseSSE } from './sse.js';
import { asCancelled, effortFor, isPlainObject, makeUsage, parseToolInput, readModelData, systemWithJsonInstruction, testByListingModels, throwIfAborted } from './shared.js';

interface FunctionCall {
  id: string;
  name: string;
  args: string;
  data?: Record<string, unknown>;
}

/** Replay complete Responses items only to their original provider/model. */
function toInput(request: ChatRequest, provider: string): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    let text = '';
    const flush = () => {
      if (!text) return;
      input.push({ role: message.role, content: [{ type: 'input_text', text }] });
      text = '';
    };
    for (const part of message.parts) {
      if (part.type === 'image') throw new NeoError('bad_request', 'ChatGPT plan connections support text only.');
      if (part.type === 'text') text += part.text;
      else if (part.type === 'reasoning' && part.provider === provider && part.model === request.model && isPlainObject(part.data) && part.data['type'] === 'reasoning') {
        flush();
        input.push(part.data);
      } else if (part.type === 'tool_call') {
        flush();
        const replay = part.provider === provider && isPlainObject(part.data) && part.data['type'] === 'function_call' ? part.data : {};
        input.push({ ...replay, type: 'function_call', call_id: part.id, name: part.name, arguments: JSON.stringify(part.input ?? {}) });
      } else if (part.type === 'tool_result') {
        flush();
        input.push({ type: 'function_call_output', call_id: part.toolCallId, output: typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? null) });
      }
    }
    flush();
  }
  return input;
}

function toUsage(value: Record<string, unknown>): Usage {
  const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const input = isPlainObject(value['input_tokens_details']) ? value['input_tokens_details'] : {};
  const output = isPlainObject(value['output_tokens_details']) ? value['output_tokens_details'] : {};
  const cached = number(input['cached_tokens']);
  const reasoning = number(output['reasoning_tokens']);
  return makeUsage(number(value['input_tokens']) - cached, number(value['output_tokens']), {
    ...(cached ? { cacheRead: cached } : {}), ...(reasoning ? { reasoning } : {}),
  });
}

function summaryText(item: Record<string, unknown>): string {
  return Array.isArray(item['summary']) ? item['summary'].filter(isPlainObject).map(part => typeof part['text'] === 'string' ? part['text'] : '').join('') : '';
}

export class ChatGPTAdapter implements ProviderAdapter {
  readonly id: string;
  readonly kind = 'chatgpt';
  readonly config: ProviderConfig;
  readonly isLocal = false;
  private readonly options: ProviderOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly accessTokens = new Set<string>();

  constructor(config: ProviderConfig, options: ProviderOptions = {}) {
    if (config.kind !== 'chatgpt') throw new NeoError('config_error', `ChatGPTAdapter cannot serve provider kind "${config.kind}".`);
    this.id = config.id;
    this.config = config;
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const url = new URL(this.baseUrl);
    // Loopback overrides allow offline fixtures; production always uses the public API.
    if (this.baseUrl !== 'https://api.openai.com/v1' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
      throw new NeoError('config_error', 'ChatGPT requires the public OpenAI API endpoint.');
    }
  }

  capabilities(model: string): ModelCapabilities {
    return {
      text: true, tools: true, vision: false, reasoning: /^(?:gpt-[5-9]|o[1-9])/.test(model), embeddings: false,
      speechToText: false, textToSpeech: false, image: false, video: false,
      contextWindow: 128_000, maxOutputTokens: 16_384,
    };
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    throwIfAborted(request.signal);
    const json = request.responseFormat === 'json';
    const body: Record<string, unknown> = { model: request.model, input: toInput(request, this.kind), store: false, stream: true };
    const instructions = systemWithJsonInstruction(request.system, json);
    if (instructions) body['instructions'] = instructions;
    if (json) body['text'] = { format: { type: 'json_object' } };
    if (this.capabilities(request.model).reasoning) {
      const effort = effortFor(request.reasoning);
      if (effort) body['reasoning'] = { effort };
      // Encrypted reasoning can be replayed while store:false keeps responses stateless.
      body['include'] = ['reasoning.encrypted_content'];
    }
    if (request.tools?.length) {
      if (request.tools.some(tool => 'type' in tool && tool.type !== 'function')) {
        throw new NeoError('bad_request', 'ChatGPT plan connections support function tools only.');
      }
      body['tools'] = request.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }));
      if (request.toolChoice) body['tool_choice'] = request.toolChoice;
    }
    // Plan tokens reject temperature and max_output_tokens, so neither is sent.
    const { response, token } = await this.request('/responses', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'text/event-stream' } }, request.signal);
    if (!response.body) throw new NeoError('provider_error', 'ChatGPT returned an empty response.', { retryable: true });

    const calls = new Map<string, FunctionCall>();
    const finished = new Set<string>();
    let usage: Usage | undefined;
    let stopReason: StopReason | undefined;
    let refused = false;
    const remember = (item: Record<string, unknown>, fallback: string): FunctionCall => {
      const key = typeof item['id'] === 'string' ? item['id'] : fallback;
      let call = calls.get(key);
      if (!call) {
        call = { id: typeof item['call_id'] === 'string' ? item['call_id'] : key, name: '', args: '' };
        calls.set(key, call);
      }
      if (typeof item['call_id'] === 'string') call.id = item['call_id'];
      if (typeof item['name'] === 'string') call.name = item['name'];
      if (typeof item['arguments'] === 'string') call.args = item['arguments'];
      call.data = item;
      return call;
    };
    const finishCall = (call: FunctionCall): ChatStreamEvent | undefined => {
      if (finished.has(call.id)) return undefined;
      if (!call.name || !call.id) throw new NeoError('provider_error', 'ChatGPT returned an invalid function call.');
      finished.add(call.id);
      return { type: 'tool_call', id: call.id, name: call.name, input: parseToolInput(call.args), ...(call.data ? { data: call.data } : {}) };
    };
    try {
      for await (const frame of parseSSE(response.body, request.signal)) {
        if (frame.data === '[DONE]') break;
        let event: unknown;
        try { event = JSON.parse(frame.data) as unknown; } catch { continue; }
        if (!isPlainObject(event)) continue;
        const type = typeof event['type'] === 'string' ? event['type'] : frame.event;
        if (type === 'response.failed' || type === 'error') {
          const result = isPlainObject(event['response']) ? event['response'] : event;
          throw this.error(result['error'] ?? result, undefined, token);
        }
        if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
          if (type === 'response.refusal.delta') refused = true;
          if (typeof event['delta'] === 'string' && event['delta']) yield { type: 'text', text: event['delta'] };
        } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
          if (typeof event['delta'] === 'string' && event['delta']) yield { type: 'reasoning', text: event['delta'] };
        } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
          const item = event['item'];
          if (!isPlainObject(item)) continue;
          if (item['type'] === 'function_call') {
            const call = remember(item, String(event['output_index'] ?? calls.size));
            if (type === 'response.output_item.done') {
              const complete = finishCall(call);
              if (complete) yield complete;
            }
          } else if (item['type'] === 'reasoning' && type === 'response.output_item.done') {
            yield { type: 'reasoning_part', part: { type: 'reasoning', text: summaryText(item), provider: this.kind, model: request.model, data: item } };
          }
        } else if (type === 'response.function_call_arguments.delta') {
          const key = typeof event['item_id'] === 'string' ? event['item_id'] : String(event['output_index']);
          const call = calls.get(key);
          if (call && typeof event['delta'] === 'string') call.args += event['delta'];
        } else if (type === 'response.function_call_arguments.done') {
          const key = typeof event['item_id'] === 'string' ? event['item_id'] : String(event['output_index']);
          const call = calls.get(key);
          if (call && typeof event['arguments'] === 'string') call.args = event['arguments'];
        } else if (type === 'response.completed' || type === 'response.incomplete') {
          const result = isPlainObject(event['response']) ? event['response'] : {};
          if (isPlainObject(result['usage'])) usage = toUsage(result['usage']);
          if (Array.isArray(result['output'])) {
            for (const item of result['output'].filter(isPlainObject)) {
              if (item['type'] === 'function_call') {
                const complete = finishCall(remember(item, String(calls.size)));
                if (complete) yield complete;
              }
            }
          }
          for (const call of calls.values()) {
            const complete = finishCall(call);
            if (complete) yield complete;
          }
          const details = isPlainObject(result['incomplete_details']) ? result['incomplete_details'] : {};
          if (type === 'response.incomplete' && details['reason'] !== 'max_output_tokens' && details['reason'] !== 'content_filter') {
            throw new NeoError('provider_error', 'ChatGPT could not complete the response. Try again later.', { retryable: true });
          }
          stopReason = details['reason'] === 'max_output_tokens' ? 'max_tokens'
            : details['reason'] === 'content_filter' || refused ? 'refusal' : finished.size ? 'tool_use' : 'end';
          break;
        }
      }
    } catch (error) {
      const cancelled = asCancelled(error, request.signal);
      if (cancelled) throw cancelled;
      if (error instanceof NeoError) throw error;
      throw new NeoError('provider_error', 'The connection to ChatGPT was interrupted. Try again later.', { retryable: true });
    }
    throwIfAborted(request.signal);
    if (!stopReason) throw new NeoError('provider_error', 'The connection to ChatGPT closed before the response finished.', { retryable: true });
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', stopReason };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { response } = await this.request('/models', {}, signal);
    const json = await readModelData(response, 'ChatGPT', 'data', signal);
    return (json['data'] as unknown[]).filter(isPlainObject).filter(model => model['visibility'] === 'list').map(model => {
      const slug = model['slug'];
      if (typeof slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(slug) || /^sk-|^eyJ/.test(slug) || [...this.accessTokens].some(token => slug.includes(token))) {
        throw new NeoError('provider_error', 'ChatGPT returned invalid model data.');
      }
      return { id: slug, provider: this.id, label: slug, capabilities: this.capabilities(slug) };
    });
  }

  test(signal?: AbortSignal): Promise<ProviderTestResult> {
    return testByListingModels(() => this.listModels(signal));
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<{ response: Response; token: string }> {
    throwIfAborted(signal);
    if (!this.options.getChatGPTAccessToken) throw chatgptSubscriptionError('subscription_sharing_invalid_user');
    let token: string;
    try { token = await this.options.getChatGPTAccessToken(this.id); } catch (error) {
      if (error instanceof NeoError) throw error;
      throw chatgptSubscriptionError('subscription_sharing_invalid_user');
    }
    if (!token) throw chatgptSubscriptionError('subscription_sharing_invalid_user');
    this.accessTokens.add(token);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    let response: Response;
    try { response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal, redirect: 'error' }); } catch (error) {
      const cancelled = asCancelled(error, signal);
      if (cancelled) throw cancelled;
      throw new NeoError('provider_error', "Can't reach ChatGPT. Try again later.", { retryable: true });
    }
    if (!response.ok) {
      let value: unknown;
      try { value = await response.json(); } catch { /* upstream body is never reflected */ }
      throw this.error(isPlainObject(value) ? value['error'] : undefined, response.status, token);
    }
    return { response, token };
  }

  private error(value: unknown, status: number | undefined, token: string): NeoError {
    const reason = isPlainObject(value) && typeof value['code'] === 'string' ? value['code'] : '';
    if (reason === 'subscription_sharing_invalid_user' || reason === 'invalid_grant' || status === 401) this.options.onChatGPTUnauthorized?.(this.id, token);
    return chatgptSubscriptionError(reason, status);
  }
}
