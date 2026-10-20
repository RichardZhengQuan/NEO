/**
 * OpenAI, OpenAI-compatible (LM Studio, vLLM, llama.cpp, OpenRouter, Groq…) and Ollama
 * adapter over raw fetch. See docs/PROVIDERS.md, "OpenAI and OpenAI-compatible".
 *
 * - `POST {base}/chat/completions` with `stream: true` (+ `stream_options.include_usage` for `openai`).
 * - Ollama: chat on `<root>/v1`, models on `<root>/api/tags`, embeddings on `<root>/api/embed`.
 * - Tool-call fragments are accumulated per index and emitted once, complete, at the end.
 */
import { NeoError, PROVIDER_PRESETS, isLocalUrl } from '@neo/protocol';
import type {
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  EmbedRequest,
  ModelCapabilities,
  ModelInfo,
  ProviderAdapter,
  ProviderConfig,
  ProviderTestResult,
  Source,
  StopReason,
  Usage,
} from '@neo/protocol';
import type { ProviderOptions } from './index.js';
import { withRetry } from './retry.js';
import { parseSSE } from './sse.js';
import {
  REFUSAL_NOTE,
  addSource,
  asCancelled,
  describeNetworkError,
  effortFor,
  hasHeader,
  hostOf,
  isPlainObject,
  makeUsage,
  missingKeyError,
  newCallId,
  parseRetryAfter,
  parseToolInput,
  redact,
  readModelData,
  resolveApiKey,
  systemWithJsonInstruction,
  testByListingModels,
  throwIfAborted,
} from './shared.js';

type OpenAIKind = 'openai' | 'openai-compatible' | 'ollama';

/** Reasoning models (o-series, gpt-5): `reasoning_effort`, no `temperature`. Matched after any vendor prefix ("openai/gpt-5"). */
const REASONING_MODEL_RE = /^(o\d|gpt-5)/;
const VISION_MODEL_RE = /llava|vision|-vl\b|gemma3|llama3\.2-vision|qwen2\.5vl|gpt-4o|gpt-5/i;
const EMBEDDING_MODEL_RE = /embed/i;
const TRANSCRIPTION_MODEL_RE = /^(?:whisper(?:-|$)|gpt-[\w.-]*transcribe(?:-|$))/;
const SPEECH_MODEL_RE = /^(?:tts(?:-|$)|gpt-[\w.-]*tts(?:-|$))/;
const IMAGE_MODEL_RE = /^(?:dall-e(?:-|$)|gpt-image(?:-|$))/;
const VIDEO_MODEL_RE = /^sora(?:-|$)/;
const NON_CHAT_MODEL_RE = /(?:^|[-.])(?:audio|realtime|moderation)(?:[-.]|$)|^(?:davinci|babbage)-002$/;

/** Context-window hints for common models (first match wins); default 32k. */
const CONTEXT_TABLE: [RegExp, number][] = [
  [/gpt-5/, 400_000],
  [/gpt-4\.1/, 1_000_000],
  [/gpt-4o|gpt-4-turbo/, 128_000],
  [/\bo\d/, 200_000],
  [/llama-?3\.[1-9]|llama-?4/, 128_000],
  [/qwen-?2\.5|qwen-?3|qwq/, 128_000],
  [/gemma-?3/, 128_000],
  [/mistral-(large|small|nemo)|mixtral|mistral/, 32_000],
  [/phi-?[34]/, 128_000],
  [/deepseek/, 128_000],
];

function baseModelName(model: string): string {
  return (model.split('/').pop() ?? model).toLowerCase();
}

/** Chat Completions supports hosted search only on dedicated `*-search-*` models.
 * General GPT models require Responses; update this one predicate when support changes.
 */
export function supportsOpenAIWebSearch(model: string): boolean {
  return /^[a-z0-9][a-z0-9.-]*-search-[a-z0-9.-]+$/i.test(model);
}

/** Search-preview families use hosted search without function tools, sampling or JSON mode.
 * Keep this conservative compatibility guard specific to the official OpenAI endpoint.
 */
const SEARCH_PREVIEW_MODEL_RE = /^gpt-4o(?:-mini)?-search-preview(?:-|$)/i;

function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_RE.test(baseModelName(model));
}

function guessContextWindow(model: string): number {
  const name = model.toLowerCase();
  for (const [re, size] of CONTEXT_TABLE) if (re.test(name)) return size;
  return 32_000;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

type ContentPiece = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPiece[] }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** ChatMessage[] → chat-completions messages. Reasoning is never replayed to these providers. */
export function toOpenAIMessages(messages: readonly ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const hasImage = msg.parts.some((p) => p.type === 'image');
      if (!hasImage) {
        const text = msg.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
        if (text) out.push({ role: 'user', content: text });
        continue;
      }
      const content: ContentPiece[] = [];
      for (const p of msg.parts) {
        if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
        else if (p.type === 'image') {
          const url = p.data ? `data:${p.mediaType};base64,${p.data}` : p.url;
          if (url) content.push({ type: 'image_url', image_url: { url } });
        }
      }
      if (content.length) out.push({ role: 'user', content });
    } else if (msg.role === 'assistant') {
      let text = '';
      const toolCalls: WireToolCall[] = [];
      for (const p of msg.parts) {
        if (p.type === 'text') text += p.text;
        else if (p.type === 'tool_call') {
          toolCalls.push({ id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } });
        }
      }
      if (!text && toolCalls.length === 0) continue;
      out.push(toolCalls.length ? { role: 'assistant', content: text || null, tool_calls: toolCalls } : { role: 'assistant', content: text });
    } else {
      for (const p of msg.parts) {
        if (p.type !== 'tool_result') continue;
        out.push({ role: 'tool', tool_call_id: p.toolCallId, content: typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? null) });
      }
    }
  }
  return out;
}

interface ToolAccumulator {
  /** Server-supplied id (some servers never send one). */
  id: string | undefined;
  name: string;
  args: string;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly id: string;
  readonly kind: OpenAIKind;
  readonly config: ProviderConfig;
  readonly isLocal: boolean;

  private readonly options: ProviderOptions;
  private readonly fetchImpl: typeof fetch;
  /** Chat-completions base ("…/v1"). */
  private readonly baseUrl: string;
  /** Ollama server root (native /api endpoints). */
  private readonly ollamaRoot: string;
  private readonly listedCapabilities = new Map<string, ModelCapabilities>();

  private get openRouter(): boolean {
    return this.kind === 'openai-compatible' && this.baseUrl === 'https://openrouter.ai/api/v1';
  }

  private supportsWebSearch(model: string): boolean {
    return this.openRouter || (this.kind === 'openai' && this.baseUrl === 'https://api.openai.com/v1' && supportsOpenAIWebSearch(model));
  }

  private isSearchPreview(model: string): boolean {
    return this.kind === 'openai' && this.baseUrl === 'https://api.openai.com/v1' && SEARCH_PREVIEW_MODEL_RE.test(model);
  }

  constructor(config: ProviderConfig, options: ProviderOptions = {}) {
    if (config.kind !== 'openai' && config.kind !== 'openai-compatible' && config.kind !== 'ollama') {
      throw new NeoError('config_error', `OpenAIAdapter cannot serve provider kind "${config.kind}".`);
    }
    this.id = config.id;
    this.kind = config.kind;
    this.config = config;
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    const preset = PROVIDER_PRESETS[config.kind].baseUrl ?? 'https://api.openai.com/v1';
    const base = (config.baseUrl ?? preset).replace(/\/+$/, '');
    // The Ollama preset has no /v1; accept a base URL with it too.
    this.ollamaRoot = base.replace(/\/v1$/, '');
    this.baseUrl = config.kind === 'ollama' ? `${this.ollamaRoot}/v1` : base;
    this.isLocal = config.local ?? (config.kind === 'ollama' || isLocalUrl(this.baseUrl));
  }

  capabilities(model: string): ModelCapabilities {
    const listed = this.listedCapabilities.get(model);
    if (listed) return listed;
    const name = baseModelName(model);
    const reasoning = isReasoningModel(model);
    const embeddings = EMBEDDING_MODEL_RE.test(model);
    const speechToText = TRANSCRIPTION_MODEL_RE.test(name);
    const textToSpeech = SPEECH_MODEL_RE.test(name);
    const image = IMAGE_MODEL_RE.test(name);
    const video = VIDEO_MODEL_RE.test(name);
    const text = !embeddings && !speechToText && !textToSpeech && !image && !video && !NON_CHAT_MODEL_RE.test(name);
    return {
      text,
      nativeWebSearch: text && this.supportsWebSearch(model),
      speechToText,
      textToSpeech,
      image,
      video,
      tools: text && !this.isSearchPreview(model),
      vision: text && VISION_MODEL_RE.test(model),
      reasoning: text && reasoning,
      embeddings,
      contextWindow: guessContextWindow(model),
      maxOutputTokens: reasoning ? 100_000 : 16_384,
    };
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    throwIfAborted(request.signal);
    const headers = this.headers({ 'content-type': 'application/json', accept: 'text/event-stream' });
    const body = this.buildBody(request);

    const response = await this.request(`${this.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, request.signal, true);
    if (!response.body) throw new NeoError('provider_error', `${this.label()} returned an empty response.`, { retryable: true });

    const tools: ToolAccumulator[] = [];
    const byIndex = new Map<number, ToolAccumulator>();
    const sources: Source[] = [];
    let finishReason: string | null = null;
    let sawText = false;
    let refused = false;
    let ended = false;
    let usage: Usage | null = null;

    try {
      for await (const msg of parseSSE(response.body, request.signal)) {
        if (msg.data.trim() === '[DONE]') {
          ended = true;
          break;
        }
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(msg.data) as Record<string, unknown>;
        } catch {
          continue; // keep-alive noise from some servers
        }
        if (chunk['error']) throw this.streamError(chunk['error']);
        if (isPlainObject(chunk['usage'])) usage = toUsage(chunk['usage']);

        const choice = Array.isArray(chunk['choices']) ? (chunk['choices'][0] as Record<string, unknown> | undefined) : undefined;
        if (!choice) continue;
        if (typeof choice['finish_reason'] === 'string' && choice['finish_reason']) finishReason = choice['finish_reason'];
        const delta = choice['delta'];
        if (isPlainObject(choice['message'])) collectAnnotations(sources, choice['message']['annotations']);
        if (!isPlainObject(delta)) continue;
        collectAnnotations(sources, delta['annotations']);

        const reasoning = delta['reasoning_content'] ?? delta['reasoning'];
        if (typeof reasoning === 'string' && reasoning) {
          throwIfAborted(request.signal);
          yield { type: 'reasoning', text: reasoning };
        }
        if (typeof delta['content'] === 'string' && delta['content']) {
          sawText = true;
          throwIfAborted(request.signal);
          yield { type: 'text', text: delta['content'] };
        }
        // OpenAI streams a model refusal as `delta.refusal` text instead of content.
        if (typeof delta['refusal'] === 'string' && delta['refusal']) {
          sawText = true;
          refused = true;
          throwIfAborted(request.signal);
          yield { type: 'text', text: delta['refusal'] };
        }
        if (Array.isArray(delta['tool_calls'])) {
          for (const tc of delta['tool_calls'] as unknown[]) if (isPlainObject(tc)) accumulateToolCall(tc, tools, byIndex);
        }
      }
    } catch (err) {
      const cancelled = asCancelled(err, request.signal);
      if (cancelled) throw cancelled;
      if (err instanceof NeoError) throw err;
      throw new NeoError('provider_error', this.clean(`The connection to ${this.label()} was interrupted: ${describeNetworkError(err)}`), {
        retryable: true,
        cause: err,
      });
    }

    throwIfAborted(request.signal);
    if (!ended && !finishReason) {
      throw new NeoError('provider_error', `The connection to ${this.label()} closed before the response finished.`, { retryable: true });
    }

    for (const tc of tools) {
      throwIfAborted(request.signal);
      yield { type: 'tool_call', id: tc.id ?? newCallId('call'), name: tc.name, input: parseToolInput(tc.args) };
    }

    let stopReason: StopReason;
    if (finishReason === 'length') stopReason = 'max_tokens';
    else if (finishReason === 'content_filter' || refused) stopReason = 'refusal';
    // Some servers (Ollama) answer "stop" even when they called tools.
    else if (finishReason === 'tool_calls' || finishReason === 'function_call' || tools.length > 0) stopReason = 'tool_use';
    else stopReason = 'end';

    if (stopReason === 'refusal' && !sawText) {
      throwIfAborted(request.signal);
      yield { type: 'text', text: REFUSAL_NOTE };
    }
    if (sources.length) {
      throwIfAborted(request.signal);
      yield { type: 'sources', items: sources };
    }
    if (usage) {
      throwIfAborted(request.signal);
      yield { type: 'usage', usage };
    }
    throwIfAborted(request.signal);
    yield { type: 'done', stopReason };
  }

  private buildBody(request: ChatRequest): Record<string, unknown> {
    const reasoningModel = isReasoningModel(request.model);
    const searchPreview = this.isSearchPreview(request.model);
    const json = request.responseFormat === 'json';
    const messages: WireMessage[] = toOpenAIMessages(request.messages);
    const system = systemWithJsonInstruction(request.system, json);
    if (system) messages.unshift({ role: 'system', content: system });

    const body: Record<string, unknown> = { model: request.model, messages, stream: true };
    if (this.kind === 'openai') body['stream_options'] = { include_usage: true };
    if (request.maxTokens !== undefined) body[this.kind === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = request.maxTokens;
    if (reasoningModel) {
      const effort = effortFor(request.reasoning);
      if (effort) body['reasoning_effort'] = effort;
    } else if (request.temperature !== undefined && !searchPreview) {
      body['temperature'] = request.temperature;
    }
    if (request.tools?.length && !searchPreview) {
      body['tools'] = request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
      // tool_choice is only valid together with tools; forced choice is never sent.
      if (request.toolChoice) body['tool_choice'] = request.toolChoice;
    }
    if (request.webSearch && this.capabilities(request.model).nativeWebSearch) {
      if (this.openRouter) body['plugins'] = [{ id: 'web' }];
      else body['web_search_options'] = {};
    }
    if (json && this.kind !== 'openai-compatible' && !searchPreview) body['response_format'] = { type: 'json_object' };
    return body;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    if (this.kind === 'ollama') {
      const resp = await this.request(`${this.ollamaRoot}/api/tags`, { headers: this.headers({}) }, signal, false);
      const json = await readModelData(resp, 'Ollama', 'models', signal);
      return (json['models'] as unknown[])
        .filter(isPlainObject)
        .map((m) => typeof m['name'] === 'string' ? m['name'] : typeof m['model'] === 'string' ? m['model'] : '')
        .filter(Boolean)
        .map((id) => {
          if (this.clean(id) !== id) throw new NeoError('provider_error', 'Ollama returned invalid model data.');
          return { id, provider: this.id, label: id, capabilities: this.capabilities(id) };
        });
    }
    const resp = await this.request(`${this.baseUrl}/models`, { headers: this.headers({}) }, signal, false);
    const label = this.clean(this.label());
    const json = await readModelData(resp, label, 'data', signal);
    this.listedCapabilities.clear();
    return (json['data'] as unknown[])
      .filter(isPlainObject)
      .filter((m) => typeof m['id'] === 'string' && m['id'] !== '')
      .map((m) => {
        const id = m['id'] as string;
        if (this.clean(id) !== id) throw new NeoError('provider_error', `${label} returned invalid model data.`);
        const capabilities = this.modelCapabilities(m, id);
        this.listedCapabilities.set(id, capabilities);
        return { id, provider: this.id, label: this.clean(typeof m['display_name'] === 'string' ? m['display_name'] : typeof m['name'] === 'string' ? m['name'] : id), capabilities };
      });
  }

  private modelCapabilities(model: Record<string, unknown>, id: string): ModelCapabilities {
    const caps = this.capabilities(id);
    const architecture = isPlainObject(model['architecture']) ? model['architecture'] : {};
    const inputs = Array.isArray(architecture['input_modalities']) ? architecture['input_modalities'] : undefined;
    const outputs = Array.isArray(architecture['output_modalities']) ? architecture['output_modalities'] : undefined;
    const parameters = Array.isArray(model['supported_parameters']) ? model['supported_parameters'] : undefined;
    const topProvider = isPlainObject(model['top_provider']) ? model['top_provider'] : {};
    const text = outputs ? outputs.includes('text') && (!inputs || inputs.includes('text')) : caps.text;
    return {
      ...caps,
      text,
      nativeWebSearch: !!text && this.supportsWebSearch(id),
      tools: !!text && !this.isSearchPreview(id) && (parameters ? parameters.includes('tools') : caps.tools),
      vision: !!text && (inputs ? inputs.includes('image') : caps.vision),
      reasoning: !!text && (parameters ? parameters.includes('reasoning') || parameters.includes('reasoning_effort') : caps.reasoning),
      embeddings: outputs ? outputs.includes('embedding') || outputs.includes('embeddings') : caps.embeddings,
      speechToText: inputs && outputs ? inputs.includes('audio') && outputs.includes('text') : caps.speechToText,
      textToSpeech: inputs && outputs ? inputs.includes('text') && outputs.includes('audio') : caps.textToSpeech,
      image: outputs ? outputs.includes('image') : caps.image,
      video: outputs ? outputs.includes('video') : caps.video,
      contextWindow: positiveNumber(model['context_length']) ?? caps.contextWindow,
      maxOutputTokens: positiveNumber(topProvider['max_completion_tokens']) ?? caps.maxOutputTokens,
    };
  }

  async embed(request: EmbedRequest): Promise<number[][]> {
    const headers = this.headers({ 'content-type': 'application/json' });
    const body = JSON.stringify({ model: request.model, input: request.texts });
    let vectors: number[][];
    if (this.kind === 'ollama') {
      const resp = await this.request(`${this.ollamaRoot}/api/embed`, { method: 'POST', headers, body }, request.signal, false);
      vectors = ((await resp.json()) as { embeddings?: number[][] }).embeddings ?? [];
    } else {
      const resp = await this.request(`${this.baseUrl}/embeddings`, { method: 'POST', headers, body }, request.signal, false);
      const data = ((await resp.json()) as { data?: { index?: number; embedding?: number[] }[] }).data ?? [];
      vectors = [...data].sort((x, y) => (x.index ?? 0) - (y.index ?? 0)).map((d) => d.embedding ?? []);
    }
    if (vectors.length !== request.texts.length) {
      throw new NeoError('provider_error', `${this.label()} returned ${vectors.length} embeddings for ${request.texts.length} texts.`);
    }
    return vectors;
  }

  test(signal?: AbortSignal): Promise<ProviderTestResult> {
    return testByListingModels(() => this.listModels(signal));
  }

  // ───────────────────────────── HTTP plumbing ─────────────────────────────

  private apiKey(): string | undefined {
    const key = resolveApiKey(this.config, this.options);
    if (!key && PROVIDER_PRESETS[this.kind].needsKey && !hasHeader(this.config.headers, 'authorization')) {
      throw missingKeyError(this.config);
    }
    return key;
  }

  private headers(base: Record<string, string>): Record<string, string> {
    const headers = { ...base };
    const key = this.apiKey();
    if (key) headers['authorization'] = `Bearer ${key}`;
    for (const [k, v] of Object.entries(this.config.headers ?? {})) headers[k.toLowerCase()] = v;
    return headers;
  }

  /** fetch (with pre-first-byte retries for chat) + error mapping. Returns an OK response. */
  private async request(url: string, init: RequestInit, signal: AbortSignal | undefined, retry: boolean): Promise<Response> {
    const attempt = () => this.fetchImpl(url, { ...init, signal });
    let response: Response;
    try {
      response = retry ? await withRetry({ attempt, signal, sleep: this.options.sleep }) : await attempt();
    } catch (err) {
      const cancelled = asCancelled(err, signal);
      if (cancelled) throw cancelled;
      throw this.networkError(err);
    }
    if (!response.ok) throw await this.httpError(response);
    return response;
  }

  private label(): string {
    return this.kind === 'ollama' ? 'Ollama' : this.kind === 'openai' ? 'OpenAI' : (this.config.label ?? hostOf(this.baseUrl));
  }

  /** Redact the API key and credential-looking custom headers from user-visible text. */
  private clean(text: string): string {
    const secrets: (string | undefined)[] = [resolveApiKey(this.config, this.options)];
    for (const [name, value] of Object.entries(this.config.headers ?? {})) {
      if (/auth|key|token|secret/i.test(name)) secrets.push(value, value.replace(/^bearer\s+/i, ''));
    }
    return redact(text, secrets);
  }

  private networkError(err: unknown): NeoError {
    const detail = err instanceof NeoError ? err.message.replace(/^Network error: /, '') : describeNetworkError(err);
    const message =
      this.kind === 'ollama'
        ? `Can't reach Ollama at ${this.ollamaRoot}. Is it running? (\`ollama serve\`) — ${detail}`
        : `Can't reach ${this.label()} at ${hostOf(this.baseUrl)}: ${detail}`;
    return new NeoError('provider_error', this.clean(message), { retryable: true, cause: err });
  }

  private async httpError(response: Response): Promise<NeoError> {
    const text = await response.text().catch(() => '');
    let message = text.trim().slice(0, 1000);
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const e = parsed.error;
      if (typeof e === 'string') message = e;
      else if (isPlainObject(e) && typeof e['message'] === 'string') message = e['message'];
      else if (typeof parsed.message === 'string') message = parsed.message;
    } catch {
      /* not JSON: keep the text */
    }
    const status = response.status;
    const detail = this.clean(`${this.label()} error (HTTP ${status})${message ? `: ${message}` : ''}`);
    if (status === 401 || status === 403) return new NeoError('provider_auth', detail, { details: { status } });
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      return new NeoError('rate_limited', detail, { retryable: true, details: { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } });
    }
    if (status === 404 && this.kind === 'ollama' && /not found/i.test(message)) {
      return new NeoError('provider_error', `${detail} — download it with \`ollama pull <model>\`.`, { details: { status } });
    }
    return new NeoError('provider_error', detail, { retryable: status >= 500, details: { status } });
  }

  private streamError(error: unknown): NeoError {
    const message = isPlainObject(error) && typeof error['message'] === 'string' ? error['message'] : typeof error === 'string' ? error : JSON.stringify(error);
    return new NeoError('provider_error', this.clean(`${this.label()} error: ${message}`), { retryable: true });
  }
}

/** OpenAI and OpenRouter share the Chat Completions URL-citation annotation shape. */
function collectAnnotations(sources: Source[], annotations: unknown): void {
  if (!Array.isArray(annotations)) return;
  for (const annotation of annotations) {
    if (!isPlainObject(annotation) || annotation['type'] !== 'url_citation') continue;
    const citation = isPlainObject(annotation['url_citation']) ? annotation['url_citation'] : annotation;
    addSource(sources, citation['url'], citation['title'], citation['content']);
  }
}

/** Merge one streamed tool-call fragment. Servers that omit `index` send each call whole (or continue the last one). */
function accumulateToolCall(tc: Record<string, unknown>, tools: ToolAccumulator[], byIndex: Map<number, ToolAccumulator>): void {
  const fn = isPlainObject(tc['function']) ? tc['function'] : {};
  const id = typeof tc['id'] === 'string' && tc['id'] ? tc['id'] : undefined;
  const name = typeof fn['name'] === 'string' ? fn['name'] : '';
  const args = typeof fn['arguments'] === 'string' ? fn['arguments'] : isPlainObject(fn['arguments']) ? JSON.stringify(fn['arguments']) : '';

  let acc: ToolAccumulator | undefined;
  if (typeof tc['index'] === 'number') {
    acc = byIndex.get(tc['index']);
    if (!acc) {
      acc = { id, name, args: '' };
      byIndex.set(tc['index'], acc);
      tools.push(acc);
    }
  } else {
    const last = tools[tools.length - 1];
    // Without an index, a fragment that carries a new id or a function name starts a new call.
    const startsNew = !last || (id !== undefined && id !== last.id) || (id === undefined && name !== '' && last.name !== '');
    acc = startsNew ? { id, name, args: '' } : last;
    if (startsNew) tools.push(acc);
  }
  acc.id ??= id;
  if (!acc.name) acc.name = name;
  acc.args += args;
}

function toUsage(u: Record<string, unknown>): Usage {
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const prompt = num(u['prompt_tokens']);
  const promptDetails = isPlainObject(u['prompt_tokens_details']) ? u['prompt_tokens_details'] : {};
  const completionDetails = isPlainObject(u['completion_tokens_details']) ? u['completion_tokens_details'] : {};
  const cached = typeof promptDetails['cached_tokens'] === 'number' && promptDetails['cached_tokens'] > 0 ? promptDetails['cached_tokens'] : null;
  const reasoning = typeof completionDetails['reasoning_tokens'] === 'number' && completionDetails['reasoning_tokens'] > 0 ? completionDetails['reasoning_tokens'] : null;
  // Prompt tokens include cached ones; report them separately (as Anthropic does).
  return makeUsage(prompt - (cached ?? 0), num(u['completion_tokens']), { cacheRead: cached, reasoning });
}
