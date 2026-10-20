/**
 * Google Gemini adapter (Generative Language API over raw fetch). See docs/PROVIDERS.md, "Gemini".
 *
 * - `POST {base}/models/{model}:streamGenerateContent?alt=sse`, key in `x-goog-api-key`
 *   (never in the URL, where proxies and error messages would leak it).
 * - Tool schemas are reduced to Gemini's OpenAPI subset ({@link sanitizeGeminiSchema}).
 * - Thought parts become reasoning; a `thoughtSignature` is kept in the part's `data`
 *   (reasoning parts and tool calls) and replayed on the same part type for the same model.
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
import { retryBeforeFirstByte } from './retry.js';
import { parseSSE } from './sse.js';
import {
  REFUSAL_NOTE,
  addSource,
  asCancelled,
  describeNetworkError,
  hasHeader,
  hostOf,
  isPlainObject,
  makeUsage,
  missingKeyError,
  newCallId,
  parseRetryAfter,
  redact,
  readModelData,
  resolveApiKey,
  testByListingModels,
  throwIfAborted,
} from './shared.js';

const DEFAULT_BASE = PROVIDER_PRESETS.gemini.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';

/** Models that can return thought summaries (2.5 and later). */
const THINKING_MODEL_RE = /gemini-(?:2\.5|[3-9])/;
const REFUSAL_FINISH = new Set(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']);

function modelPath(model: string): string {
  return model.replace(/^models\//, '');
}

// ───────────────────────────── schema sanitizer ─────────────────────────────

/** Keywords of Gemini's OpenAPI-3 schema subset that are passed through (after sanitizing). */
const SCALAR_KEYS = new Set(['title', 'description', 'nullable', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum']);
const FORMATS: Record<string, Set<string>> = {
  string: new Set(['enum', 'date-time']),
  number: new Set(['float', 'double']),
  integer: new Set(['int32', 'int64']),
};

/**
 * JSON Schema → Gemini function-declaration schema: drops `$schema`, `additionalProperties`
 * and other unsupported keywords, inlines `$ref`s into `$defs`/`definitions`, turns string
 * `const` into `enum`, `anyOf [X, null]` / `type: [X, 'null']` into `X` + `nullable`, keeps only
 * supported formats, and drops free-form object properties (Gemini rejects empty objects).
 */
export function sanitizeGeminiSchema(schema: unknown): unknown {
  const root = isPlainObject(schema) ? schema : {};
  const defs: Record<string, unknown> = {
    ...(isPlainObject(root['definitions']) ? root['definitions'] : {}),
    ...(isPlainObject(root['$defs']) ? root['$defs'] : {}),
  };
  return sanitizeNode(schema, defs, []) ?? {};
}

function resolveRef(ref: string, defs: Record<string, unknown>): unknown {
  const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  return m ? defs[decodeURIComponent(m[1]!).replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
}

function isNullSchema(s: unknown): boolean {
  return isPlainObject(s) && (s['type'] === 'null' || (Array.isArray(s['enum']) && s['enum'].length === 1 && s['enum'][0] === null));
}

/** Returns undefined for schemas that cannot be expressed (and should be dropped by the parent). */
function sanitizeNode(node: unknown, defs: Record<string, unknown>, refStack: string[]): Record<string, unknown> | undefined {
  if (!isPlainObject(node)) return node === true || node === undefined ? {} : undefined;

  if (typeof node['$ref'] === 'string') {
    const ref = node['$ref'];
    // Recursive definitions are expanded twice, then cut off (the cut property is dropped).
    if (refStack.filter((r) => r === ref).length >= 2) return undefined;
    const target = resolveRef(ref, defs);
    if (target === undefined) return {};
    const { $ref: _ignored, ...siblings } = node;
    const merged = isPlainObject(target) ? { ...target, ...siblings } : siblings;
    return sanitizeNode(merged, defs, [...refStack, ref]);
  }

  const variants = (node['anyOf'] ?? node['oneOf']) as unknown;
  if (Array.isArray(variants)) {
    const nonNull = variants.filter((v) => !isNullSchema(v));
    const nullable = nonNull.length < variants.length;
    const { anyOf: _a, oneOf: _o, ...rest } = node;
    if (nonNull.length === 1) {
      const inner = sanitizeNode({ ...(isPlainObject(nonNull[0]) ? nonNull[0] : {}), ...rest }, defs, refStack);
      return inner && nullable ? { ...inner, nullable: true } : inner;
    }
    const out = sanitizeNode(rest, defs, refStack) ?? {};
    const sanitized = nonNull
      .map((v) => sanitizeNode(v, defs, refStack))
      .filter((v): v is Record<string, unknown> => v !== undefined && !isEmptyObjectSchema(v));
    if (sanitized.length) out['anyOf'] = sanitized;
    if (nullable) out['nullable'] = true;
    return out;
  }
  if (Array.isArray(node['allOf']) && node['allOf'].length === 1) {
    const { allOf, ...rest } = node;
    return sanitizeNode({ ...(isPlainObject(allOf[0]) ? allOf[0] : {}), ...rest }, defs, refStack);
  }

  const out: Record<string, unknown> = {};
  let type = node['type'];
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== 'null');
    if (nonNull.length < type.length) out['nullable'] = true;
    type = nonNull[0];
  }
  if (typeof type !== 'string') {
    // Infer the obvious cases; leave the rest untyped.
    type = isPlainObject(node['properties']) ? 'object' : node['items'] !== undefined ? 'array' : Array.isArray(node['enum']) || typeof node['const'] === 'string' ? 'string' : undefined;
  }
  if (typeof type === 'string') out['type'] = type;

  for (const [key, value] of Object.entries(node)) {
    if (SCALAR_KEYS.has(key)) out[key] = value;
  }
  if (typeof node['format'] === 'string' && typeof type === 'string' && FORMATS[type]?.has(node['format'])) out['format'] = node['format'];

  if (Array.isArray(node['enum'])) {
    const values = node['enum'].filter((v) => v !== null);
    if (values.length && values.every((v) => typeof v === 'string')) out['enum'] = values;
  } else if (typeof node['const'] === 'string') {
    out['enum'] = [node['const']];
  }

  if (type === 'array') {
    if (node['items'] !== undefined) {
      const items = sanitizeNode(Array.isArray(node['items']) ? node['items'][0] : node['items'], defs, refStack);
      // Gemini requires every array to declare items. When the item schema is a free-form object
      // (e.g. z.record(z.string(), z.unknown()) on render_ui's `blocks`), it sanitizes to an empty
      // object schema that we would normally drop — instead, fall back to {type:'object'} which
      // Gemini accepts for OBJECT without explicit properties.
      if (items && !isEmptyObjectSchema(items)) {
        out['items'] = items;
      } else {
        out['items'] = { type: 'object' };
      }
    } else {
      // No items at all in the source schema: use a generic object fallback.
      out['items'] = { type: 'object' };
    }
  }

  if (type === 'object') {
    const props: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(isPlainObject(node['properties']) ? node['properties'] : {})) {
      const sanitized = sanitizeNode(value, defs, refStack);
      if (sanitized && !isEmptyObjectSchema(sanitized)) props[name] = sanitized;
    }
    // An object without (expressible) properties is reported as empty so the parent can drop it.
    out['properties'] = props;
    if (Object.keys(props).length === 0) return out;
    if (Array.isArray(node['required'])) {
      const required = node['required'].filter((r): r is string => typeof r === 'string' && r in props);
      if (required.length) out['required'] = required;
    }
  }
  return out;
}

function isEmptyObjectSchema(s: Record<string, unknown>): boolean {
  return s['type'] === 'object' && (!isPlainObject(s['properties']) || Object.keys(s['properties']).length === 0);
}

// ───────────────────────────── messages ─────────────────────────────

type GeminiPart = Record<string, unknown>;
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

function signatureOf(data: unknown, model?: string): string | undefined {
  if (!isPlainObject(data) || typeof data['thoughtSignature'] !== 'string' || !data['thoughtSignature']) return undefined;
  if (model !== undefined && data['model'] !== model) return undefined;
  return data['thoughtSignature'];
}

/** ChatMessage[] → Gemini contents. Thoughts and signatures are replayed only to the model that produced them. */
export function toGeminiContents(messages: readonly ChatMessage[], model: string): GeminiContent[] {
  const out: GeminiContent[] = [];
  const push = (role: 'user' | 'model', parts: GeminiPart[]) => {
    if (!parts.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  };

  for (const msg of messages) {
    const parts: GeminiPart[] = [];
    if (msg.role === 'user') {
      for (const p of msg.parts) {
        if (p.type === 'text') {
          if (p.text) parts.push({ text: p.text });
        } else if (p.type === 'image') {
          if (p.data) parts.push({ inlineData: { mimeType: p.mediaType, data: p.data } });
          else if (p.url) parts.push({ text: `[Image link (not loaded): ${p.url}]` });
        }
      }
      push('user', parts);
    } else if (msg.role === 'assistant') {
      for (const p of msg.parts) {
        if (p.type === 'reasoning') {
          const sig = p.provider === 'gemini' && p.model === model ? signatureOf(p.data) : undefined;
          if (sig) parts.push({ text: p.text, thought: true, thoughtSignature: sig });
        } else if (p.type === 'text') {
          if (p.text) parts.push({ text: p.text });
        } else if (p.type === 'tool_call') {
          const part: GeminiPart = { functionCall: { name: p.name, args: isPlainObject(p.input) ? p.input : {} } };
          const sig = p.provider === 'gemini' ? signatureOf(p.data, model) : undefined;
          if (sig) part['thoughtSignature'] = sig;
          parts.push(part);
        }
      }
      push('model', parts);
    } else {
      for (const p of msg.parts) {
        if (p.type !== 'tool_result') continue;
        // Gemini pairs responses with calls by function name.
        parts.push({ functionResponse: { name: p.name, response: { result: p.output ?? null } } });
      }
      push('user', parts);
    }
  }
  return out;
}

// ───────────────────────────── adapter ─────────────────────────────

export class GeminiAdapter implements ProviderAdapter {
  readonly id: string;
  readonly kind = 'gemini' as const;
  readonly config: ProviderConfig;
  readonly isLocal: boolean;

  private readonly options: ProviderOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly listedCapabilities = new Map<string, ModelCapabilities>();

  constructor(config: ProviderConfig, options: ProviderOptions = {}) {
    this.id = config.id;
    this.config = config;
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.isLocal = config.local ?? isLocalUrl(this.baseUrl);
  }

  capabilities(model: string): ModelCapabilities {
    const listed = this.listedCapabilities.get(modelPath(model));
    if (listed) return listed;
    const embeddings = /embed/i.test(model);
    const textToSpeech = /(?:^|-)tts(?:-|$)/i.test(model);
    const image = /^(?:models\/)?imagen-|gemini-.*-image(?:-|$)/i.test(model);
    const video = /^(?:models\/)?veo-/i.test(model);
    const text = !embeddings && !textToSpeech && !video && !/^(?:models\/)?imagen-/i.test(model);
    return {
      text,
      nativeWebSearch: text && !image && /gemini-(?:2\.[0-9]|[3-9])/.test(model) && this.baseUrl === DEFAULT_BASE,
      speechToText: false,
      textToSpeech,
      image,
      video,
      tools: text && !image,
      vision: text,
      reasoning: text && THINKING_MODEL_RE.test(model),
      embeddings,
      contextWindow: 1_048_576,
      maxOutputTokens: THINKING_MODEL_RE.test(model) ? 65_536 : 8_192,
    };
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    throwIfAborted(request.signal);
    const headers = this.headers();
    const model = modelPath(request.model);
    const body = this.buildBody(request, model);
    const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`;

    let response: Response;
    try {
      response = await retryBeforeFirstByte(
        () => this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: request.signal }),
        async (outcome) => {
          if (!outcome.ok) return { retry: true };
          const { status } = outcome.value;
          if (status !== 429 && status < 500) return { retry: false };
          return { retry: true, retryAfterMs: await retryDelayOf(outcome.value) };
        },
        { signal: request.signal, sleep: this.options.sleep, discard: (r) => void r.body?.cancel().catch(() => {}) },
      );
    } catch (err) {
      throw asCancelled(err, request.signal) ?? this.networkError(err);
    }
    if (!response.ok) throw await this.httpError(response);
    if (!response.body) throw new NeoError('provider_error', 'Gemini returned an empty response.', { retryable: true });

    let thought = '';
    let sawText = false;
    let finish: string | undefined;
    let blocked = false;
    let usage: Usage | null = null;
    const calls: ChatStreamEvent[] = [];
    const sources: Source[] = [];

    try {
      for await (const msg of parseSSE(response.body, request.signal)) {
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(msg.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (chunk['error']) throw this.streamError(chunk['error']);
        if (isPlainObject(chunk['usageMetadata'])) usage = toUsage(chunk['usageMetadata']);
        if (isPlainObject(chunk['promptFeedback']) && chunk['promptFeedback']['blockReason']) blocked = true;

        const candidate = Array.isArray(chunk['candidates']) ? (chunk['candidates'][0] as Record<string, unknown> | undefined) : undefined;
        if (!candidate) continue;
        collectGrounding(sources, candidate['groundingMetadata']);
        if (typeof candidate['finishReason'] === 'string' && candidate['finishReason']) finish = candidate['finishReason'];
        const content = candidate['content'];
        const parts = isPlainObject(content) && Array.isArray(content['parts']) ? (content['parts'] as unknown[]) : [];

        for (const raw of parts) {
          if (!isPlainObject(raw)) continue;
          const signature = typeof raw['thoughtSignature'] === 'string' && raw['thoughtSignature'] ? raw['thoughtSignature'] : undefined;
          if (raw['thought'] === true) {
            const text = typeof raw['text'] === 'string' ? raw['text'] : '';
            if (text) {
              thought += text;
              throwIfAborted(request.signal);
              yield { type: 'reasoning', text };
            }
            if (signature) {
              throwIfAborted(request.signal);
              yield { type: 'reasoning_part', part: { type: 'reasoning', text: thought, provider: 'gemini', model: request.model, data: { thoughtSignature: signature } } };
              thought = '';
            }
            continue;
          }
          if (typeof raw['text'] === 'string' && raw['text']) {
            sawText = true;
            throwIfAborted(request.signal);
            yield { type: 'text', text: raw['text'] };
          }
          if (isPlainObject(raw['functionCall'])) {
            const fc = raw['functionCall'];
            const call: ChatStreamEvent = {
              type: 'tool_call',
              id: typeof fc['id'] === 'string' && fc['id'] ? fc['id'] : newCallId('call'),
              name: typeof fc['name'] === 'string' ? fc['name'] : '',
              input: isPlainObject(fc['args']) ? fc['args'] : {},
            };
            if (signature) call.data = { thoughtSignature: signature, model: request.model };
            calls.push(call);
            throwIfAborted(request.signal);
            yield call;
          }
        }
      }
    } catch (err) {
      const cancelled = asCancelled(err, request.signal);
      if (cancelled) throw cancelled;
      if (err instanceof NeoError) throw err;
      throw new NeoError('provider_error', this.clean(`The connection to Gemini was interrupted: ${describeNetworkError(err)}`), { retryable: true, cause: err });
    }

    throwIfAborted(request.signal);
    if (!finish && !blocked) {
      throw new NeoError('provider_error', 'The connection to Gemini closed before the response finished.', { retryable: true });
    }

    let stopReason: StopReason;
    if (blocked || (finish && REFUSAL_FINISH.has(finish))) stopReason = 'refusal';
    else if (finish === 'MAX_TOKENS') stopReason = 'max_tokens';
    else stopReason = calls.length ? 'tool_use' : 'end';

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

  private buildBody(request: ChatRequest, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = { contents: toGeminiContents(request.messages, request.model) };
    if (request.system) body['systemInstruction'] = { parts: [{ text: request.system }] };

    const generationConfig: Record<string, unknown> = {};
    if (request.maxTokens !== undefined) generationConfig['maxOutputTokens'] = request.maxTokens;
    if (request.temperature !== undefined) generationConfig['temperature'] = request.temperature;
    if (request.responseFormat === 'json') generationConfig['responseMimeType'] = 'application/json';
    if (THINKING_MODEL_RE.test(model)) generationConfig['thinkingConfig'] = { includeThoughts: true };
    if (Object.keys(generationConfig).length) body['generationConfig'] = generationConfig;

    if (request.tools?.length) {
      body['tools'] = [
        {
          functionDeclarations: request.tools.map((t) => {
            const parameters = sanitizeGeminiSchema(t.inputSchema) as Record<string, unknown>;
            const hasParams = isPlainObject(parameters['properties']) && Object.keys(parameters['properties']).length > 0;
            return { name: t.name, description: t.description, ...(hasParams ? { parameters } : {}) };
          }),
        },
      ];
      body['toolConfig'] = { functionCallingConfig: { mode: request.toolChoice === 'none' ? 'NONE' : 'AUTO' } };
    }
    if (request.webSearch && this.capabilities(request.model).nativeWebSearch) {
      const tools = Array.isArray(body['tools']) ? body['tools'] : [];
      body['tools'] = [...tools, { google_search: {} }];
    }
    return body;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const headers = this.headers();
    const models: ModelInfo[] = [];
    this.listedCapabilities.clear();
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = `${this.baseUrl}/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const json = await readModelData(await this.get(url, headers, signal), 'Gemini', 'models', signal);
      for (const m of (json['models'] as unknown[]).filter(isPlainObject)) {
        const methods = Array.isArray(m['supportedGenerationMethods']) ? (m['supportedGenerationMethods'] as string[]) : [];
        const generatesContent = methods.includes('generateContent') || methods.includes('streamGenerateContent');
        const embeddings = methods.includes('embedContent') || methods.includes('batchEmbedContents');
        const id = typeof m['name'] === 'string' ? modelPath(m['name']) : '';
        if (!id) continue;
        if (this.clean(id) !== id) throw new NeoError('provider_error', 'Gemini returned invalid model data.');
        const caps = this.capabilities(id);
        if (!generatesContent && !embeddings && !(caps.image && methods.includes('predict')) && !(caps.video && methods.includes('predictLongRunning'))) continue;
        const text = generatesContent && caps.text !== false;
        const capabilities = {
          ...caps,
          text,
          nativeWebSearch: !!text && caps.nativeWebSearch === true,
          tools: !!text && caps.tools,
          vision: !!text && caps.vision,
          reasoning: !!text && caps.reasoning,
          embeddings,
          contextWindow: typeof m['inputTokenLimit'] === 'number' && Number.isInteger(m['inputTokenLimit']) && m['inputTokenLimit'] > 0 ? m['inputTokenLimit'] : caps.contextWindow,
          maxOutputTokens: typeof m['outputTokenLimit'] === 'number' && Number.isInteger(m['outputTokenLimit']) && m['outputTokenLimit'] > 0 ? m['outputTokenLimit'] : caps.maxOutputTokens,
        };
        this.listedCapabilities.set(id, capabilities);
        models.push({
          id,
          provider: this.id,
          label: this.clean(typeof m['displayName'] === 'string' ? m['displayName'] : id),
          capabilities,
        });
      }
      pageToken = typeof json['nextPageToken'] === 'string' ? json['nextPageToken'] || undefined : undefined;
      if (pageToken && this.clean(pageToken) !== pageToken) throw new NeoError('provider_error', 'Gemini returned invalid model data.');
      if (!pageToken) break;
    }
    return models;
  }

  async embed(request: EmbedRequest): Promise<number[][]> {
    const headers = { ...this.headers(), 'content-type': 'application/json' };
    const model = modelPath(request.model);
    const body = { requests: request.texts.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })) };
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/models/${model}:batchEmbedContents`, { method: 'POST', headers, body: JSON.stringify(body), signal: request.signal });
    } catch (err) {
      throw asCancelled(err, request.signal) ?? this.networkError(err);
    }
    if (!response.ok) throw await this.httpError(response);
    const vectors = (((await response.json()) as { embeddings?: { values?: number[] }[] }).embeddings ?? []).map((e) => e.values ?? []);
    if (vectors.length !== request.texts.length) {
      throw new NeoError('provider_error', `Gemini returned ${vectors.length} embeddings for ${request.texts.length} texts.`);
    }
    return vectors;
  }

  test(signal?: AbortSignal): Promise<ProviderTestResult> {
    return testByListingModels(() => this.listModels(signal));
  }

  // ───────────────────────────── HTTP plumbing ─────────────────────────────

  private headers(): Record<string, string> {
    const key = resolveApiKey(this.config, this.options);
    if (!key && !hasHeader(this.config.headers, 'x-goog-api-key', 'authorization')) throw missingKeyError(this.config);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers['x-goog-api-key'] = key;
    for (const [k, v] of Object.entries(this.config.headers ?? {})) headers[k.toLowerCase()] = v;
    return headers;
  }

  private async get(url: string, headers: Record<string, string>, signal: AbortSignal | undefined): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers, signal });
    } catch (err) {
      throw asCancelled(err, signal) ?? this.networkError(err);
    }
    if (!response.ok) throw await this.httpError(response);
    return response;
  }

  private clean(text: string): string {
    const secrets: (string | undefined)[] = [resolveApiKey(this.config, this.options)];
    for (const [name, value] of Object.entries(this.config.headers ?? {})) {
      if (/auth|key|token|secret/i.test(name)) secrets.push(value, value.replace(/^bearer\s+/i, ''));
    }
    return redact(text, secrets);
  }

  private networkError(err: unknown): NeoError {
    return new NeoError('provider_error', this.clean(`Can't reach Gemini at ${hostOf(this.baseUrl)}: ${describeNetworkError(err)}`), { retryable: true, cause: err });
  }

  private async httpError(response: Response): Promise<NeoError> {
    const text = await response.text().catch(() => '');
    const { message, reason, retryDelayMs } = parseErrorBody(text);
    const status = response.status;
    const detail = this.clean(`Gemini error (HTTP ${status})${message ? `: ${message}` : ''}`);
    if (status === 401 || status === 403 || reason === 'API_KEY_INVALID' || /api key not valid/i.test(message)) {
      return new NeoError('provider_auth', detail, { details: { status } });
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after')) ?? retryDelayMs;
      return new NeoError('rate_limited', detail, { retryable: true, details: { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } });
    }
    return new NeoError('provider_error', detail, { retryable: status >= 500, details: { status } });
  }

  private streamError(error: unknown): NeoError {
    const message = isPlainObject(error) && typeof error['message'] === 'string' ? error['message'] : JSON.stringify(error);
    const code = isPlainObject(error) && typeof error['code'] === 'number' ? error['code'] : 0;
    const status = isPlainObject(error) && typeof error['status'] === 'string' ? error['status'] : '';
    const { reason, retryDelayMs } = parseErrorBody(JSON.stringify({ error }));
    const detail = this.clean(`Gemini error: ${message}`);
    if (code === 401 || code === 403 || status === 'UNAUTHENTICATED' || status === 'PERMISSION_DENIED' || reason === 'API_KEY_INVALID' || /api key not valid/i.test(message)) {
      return new NeoError('provider_auth', detail, { details: { status: code } });
    }
    if (code === 429 || status === 'RESOURCE_EXHAUSTED') {
      const retryAfter = isPlainObject(error) ? error['retryAfter'] : undefined;
      const retryDelay = isPlainObject(error) ? error['retryDelay'] : undefined;
      const delayMs = (value: unknown) => typeof value === 'number' || typeof value === 'string' ? parseRetryAfter(String(value).replace(/s$/, '')) : undefined;
      const retryAfterMs = delayMs(retryAfter) ?? delayMs(retryDelay) ?? retryDelayMs;
      return new NeoError('rate_limited', detail, { retryable: true, details: { status: code, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } });
    }
    return new NeoError('provider_error', detail, { retryable: code >= 500, details: code ? { status: code } : {} });
  }
}

/** Grounding metadata contains web chunks even when the final text has no inline marker. */
function collectGrounding(sources: Source[], metadata: unknown): void {
  if (!isPlainObject(metadata) || !Array.isArray(metadata['groundingChunks'])) return;
  for (const chunk of metadata['groundingChunks']) {
    if (!isPlainObject(chunk) || !isPlainObject(chunk['web'])) continue;
    const web = chunk['web'];
    addSource(sources, web['uri'], web['title']);
  }
}

/** Fields of a Google API error body: `{ error: { message, details: [ErrorInfo{reason}, RetryInfo{retryDelay}] } }`. */
function parseErrorBody(text: string): { message: string; reason?: string; retryDelayMs?: number } {
  const out: { message: string; reason?: string; retryDelayMs?: number } = { message: text.trim().slice(0, 1000) };
  try {
    const err = (JSON.parse(text) as { error?: unknown }).error;
    if (!isPlainObject(err)) return out;
    if (typeof err['message'] === 'string') out.message = err['message'];
    for (const d of Array.isArray(err['details']) ? (err['details'] as unknown[]) : []) {
      if (!isPlainObject(d)) continue;
      if (typeof d['reason'] === 'string') out.reason = d['reason'];
      const delay = typeof d['retryDelay'] === 'string' ? parseRetryAfter(d['retryDelay'].replace(/s$/, '')) : undefined;
      if (delay !== undefined) out.retryDelayMs = delay;
    }
  } catch {
    /* not JSON */
  }
  return out;
}

/** Server back-off for a 429/5xx: the `retry-after` header, else the body's RetryInfo. */
async function retryDelayOf(response: Response): Promise<number | undefined> {
  const header = parseRetryAfter(response.headers.get('retry-after'));
  if (header !== undefined) return header;
  return parseErrorBody(await response.clone().text().catch(() => '')).retryDelayMs;
}

function toUsage(u: Record<string, unknown>): Usage {
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const cached = num(u['cachedContentTokenCount']);
  const thoughts = num(u['thoughtsTokenCount']);
  return makeUsage(num(u['promptTokenCount']) - cached, num(u['candidatesTokenCount']) + thoughts, {
    cacheRead: cached > 0 ? cached : null,
    reasoning: thoughts > 0 ? thoughts : null,
  });
}
