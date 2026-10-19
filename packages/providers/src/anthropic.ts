/**
 * Anthropic adapter (official `@anthropic-ai/sdk`). See docs/PROVIDERS.md, "Anthropic".
 *
 * Request rules for current models (Opus 5.x, Sonnet 5.x, Haiku 5.x, Fable/Mythos 5.x,
 * Opus 4.6–4.8, Sonnet 4.6): adaptive thinking with summarized display, depth via
 * `output_config.effort`, no sampling params, never `budget_tokens` or disabled
 * thinking, no forced tool choice. Older models get neither thinking nor effort.
 *
 * Retries: the SDK's own retry policy also retries 408/409 and waits out any
 * `retry-after`, so the SDK runs with `maxRetries: 0` and the shared
 * pre-first-byte policy (retry.ts) wraps `messages.create()`, which resolves as
 * soon as the response headers arrive.
 */
import Anthropic, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import type { MessageCreateParamsStreaming } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  MessageCreateParamsStreaming as BetaMessageCreateParamsStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { NeoError, PROVIDER_PRESETS, isLocalUrl } from '@neo/protocol';
import type {
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  ModelCapabilities,
  ModelInfo,
  ProviderAdapter,
  ProviderConfig,
  ProviderTestResult,
  ReasoningPart,
  Source,
  StopReason,
} from '@neo/protocol';
import type { ProviderOptions } from './index.js';
import { retryBeforeFirstByte } from './retry.js';
import {
  REFUSAL_NOTE,
  addSource,
  asCancelled,
  cancelledError,
  describeNetworkError,
  effortFor,
  hostOf,
  isPlainObject,
  makeUsage,
  missingKeyError,
  parseRetryAfter,
  parseToolInput,
  redact,
  resolveApiKey,
  systemWithJsonInstruction,
  testByListingModels,
  throwIfAborted,
} from './shared.js';

const DEFAULT_BASE_URL = PROVIDER_PRESETS.anthropic.baseUrl ?? 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 16_000;

/** Current models: adaptive thinking + effort; they reject sampling params, `budget_tokens` and (most) disabled thinking. */
const CURRENT_MODEL_RE = /(?:^|[./])claude-(?:opus-5|sonnet-5|haiku-5|fable-5|mythos-5|opus-4-[678]|sonnet-4-6)/;

/** Models offering the server-side refusal fallback (`fallbacks: 'default'`). Haiku 5.5 has none. */
const REFUSAL_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
const REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function isCurrentClaudeModel(model: string): boolean {
  return CURRENT_MODEL_RE.test(model);
}

/** Replay data understood by this adapter (stored in ReasoningPart.data). */
type ThinkingData = { type: 'thinking'; signature: string } | { type: 'redacted_thinking'; data: string };

function thinkingData(part: ReasoningPart): ThinkingData | null {
  const d = part.data;
  if (!isPlainObject(d)) return null;
  if (d['type'] === 'thinking' && typeof d['signature'] === 'string' && d['signature']) return { type: 'thinking', signature: d['signature'] };
  if (d['type'] === 'redacted_thinking' && typeof d['data'] === 'string' && d['data']) return { type: 'redacted_thinking', data: d['data'] };
  return null;
}

/**
 * ChatMessage[] → Anthropic messages. Reasoning is replayed verbatim (signature included) only for
 * the same provider + model; tool results open the user turn that follows a tool-using step.
 */
export function toAnthropicMessages(messages: readonly ChatMessage[], model: string, opts: { dropThinking?: boolean } = {}): BetaMessageParam[] {
  const out: { role: 'user' | 'assistant'; content: BetaContentBlockParam[] }[] = [];
  const push = (role: 'user' | 'assistant', content: BetaContentBlockParam[], resultsFirst = false) => {
    if (content.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content = resultsFirst ? [...content, ...last.content] : [...last.content, ...content];
    } else {
      out.push({ role, content });
    }
  };

  for (const msg of messages) {
    if (msg.role === 'user') {
      const content: BetaContentBlockParam[] = [];
      for (const p of msg.parts) {
        if (p.type === 'text') {
          if (p.text) content.push({ type: 'text', text: p.text });
        } else if (p.type === 'image') {
          if (!IMAGE_MEDIA_TYPES.has(p.mediaType)) {
            content.push({ type: 'text', text: `[An image in an unsupported format (${p.mediaType}) was omitted.]` });
          } else if (p.data) {
            content.push({
              type: 'image',
              source: { type: 'base64', media_type: p.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: p.data },
            });
          } else if (p.url) {
            content.push({ type: 'image', source: { type: 'url', url: p.url } });
          }
        }
      }
      push('user', content);
    } else if (msg.role === 'assistant') {
      const content: BetaContentBlockParam[] = [];
      for (const p of msg.parts) {
        if (p.type === 'reasoning') {
          if (opts.dropThinking || p.provider !== 'anthropic' || p.model !== model) continue;
          const data = thinkingData(p);
          if (data?.type === 'thinking') content.push({ type: 'thinking', thinking: p.text, signature: data.signature });
          else if (data?.type === 'redacted_thinking') content.push({ type: 'redacted_thinking', data: data.data });
        } else if (p.type === 'text') {
          if (p.text) content.push({ type: 'text', text: p.text });
        } else if (p.type === 'tool_call') {
          content.push({ type: 'tool_use', id: p.id, name: p.name, input: isPlainObject(p.input) ? p.input : {} });
        } else if (p.type === 'provider_part' && p.provider === 'anthropic' && p.model === model && isPlainObject(p.data)) {
          const block = p.data;
          if (block['type'] === 'native_search_message' && Array.isArray(block['content'])) {
            // Deferred NEO calls can arrive after later server blocks. The complete
            // snapshot preserves the upstream assistant step's original block order.
            const original = (block['content'] as BetaContentBlockParam[]).filter(part =>
              !opts.dropThinking || (part.type !== 'thinking' && part.type !== 'redacted_thinking'));
            content.splice(0, content.length, ...original);
          } else if (block['type'] === 'server_tool_use' || block['type'] === 'web_search_tool_result') {
            content.push(block as unknown as BetaContentBlockParam);
          } else if (block['type'] === 'text' && typeof block['text'] === 'string') {
            // Visible deltas precede the complete cited block in the transcript.
            const previous = content.at(-1);
            if (previous?.type === 'text' && previous.text.endsWith(block['text'])) {
              const prefix = previous.text.slice(0, previous.text.length - block['text'].length);
              content.pop();
              if (prefix) content.push({ type: 'text', text: prefix });
              content.push(block as unknown as BetaContentBlockParam);
            }
          }
        }
      }
      push('assistant', content);
    } else {
      const results: BetaContentBlockParam[] = [];
      for (const p of msg.parts) {
        if (p.type !== 'tool_result') continue;
        results.push({
          type: 'tool_result',
          tool_use_id: p.toolCallId,
          content: typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? null),
          ...(p.isError ? { is_error: true } : {}),
        });
      }
      // Tool results must open their user turn, ahead of any user text.
      push('user', results, true);
    }
  }
  return out;
}

function hasThinking(messages: readonly BetaMessageParam[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'));
}

/** The API's own error message (the SDK's `message` is "<status> <json body>"). */
function apiMessage(err: APIError): string {
  const body = err.error as { error?: { message?: unknown }; message?: unknown } | undefined;
  const msg = body?.error?.message ?? body?.message;
  return typeof msg === 'string' && msg ? msg : err.message;
}

function apiErrorType(err: APIError): string | undefined {
  const body = err.error as { error?: { type?: unknown } } | undefined;
  return err.type ?? (typeof body?.error?.type === 'string' ? body.error.type : undefined);
}

/** "Invalid `signature` in `thinking` block … bound to a different conversation" (and tampered signatures). */
function isThinkingSignatureError(err: unknown): boolean {
  if (!(err instanceof BadRequestError)) return false;
  const msg = apiMessage(err);
  return /bound to a different conversation/i.test(msg) || (/signature/i.test(msg) && /thinking/i.test(msg));
}

/** A 400 that rejects the refusal-fallback field or its beta header. */
function isFallbackRejected(err: unknown): boolean {
  return err instanceof BadRequestError && /fallback/i.test(apiMessage(err));
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id: string;
  readonly kind = 'anthropic' as const;
  readonly config: ProviderConfig;
  readonly isLocal: boolean;

  private readonly options: ProviderOptions;
  private readonly baseUrl: string;
  private readonly refusalFallbackWanted: boolean;
  /** Set once the API rejected the fallback field; kept for the adapter's lifetime. */
  private refusalFallbackDisabled = false;
  private client: { key: string; sdk: Anthropic } | null = null;

  constructor(config: ProviderConfig, options: ProviderOptions = {}) {
    this.id = config.id;
    this.config = config;
    this.options = options;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.isLocal = config.local ?? isLocalUrl(config.baseUrl);
    // The fallback parameter exists on the Claude API only (not Bedrock/Vertex/Foundry gateways).
    const onClaudeApi = hostOf(this.baseUrl) === hostOf(DEFAULT_BASE_URL);
    this.refusalFallbackWanted = onClaudeApi && config.options?.['refusalFallback'] !== false;
  }

  capabilities(model: string): ModelCapabilities {
    const current = isCurrentClaudeModel(model);
    return {
      text: true,
      nativeWebSearch: this.baseUrl === DEFAULT_BASE_URL && /claude-(?:(?:opus|sonnet|haiku|fable|mythos)-[45]|3-[57]-(?:sonnet|haiku))/.test(model),
      tools: true,
      vision: true,
      reasoning: current,
      embeddings: false,
      contextWindow: current ? 1_000_000 : 200_000,
      maxOutputTokens: current ? 128_000 : 64_000,
    };
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    throwIfAborted(request.signal);
    const apiKey = this.apiKey();
    const sdk = this.sdk(apiKey);
    let messages = toAnthropicMessages(request.messages, request.model);
    let strippedThinking = false;

    let stream: AsyncIterable<BetaRawMessageStreamEvent>;
    for (;;) {
      const fallback = this.useRefusalFallback(request.model);
      try {
        stream = await this.open(sdk, this.buildParams(request, messages), fallback, request.signal);
        break;
      } catch (err) {
        if (!strippedThinking && isThinkingSignatureError(err) && hasThinking(messages)) {
          // Thinking blocks are bound to the conversation prefix that produced them; after the
          // history changed, answer this turn without them (once).
          this.options.logger?.warn('anthropic: thinking blocks rejected; retrying without them', { provider: this.id });
          messages = toAnthropicMessages(request.messages, request.model, { dropThinking: true });
          strippedThinking = true;
          continue;
        }
        if (fallback && isFallbackRejected(err)) {
          this.options.logger?.warn('anthropic: refusal fallback rejected; disabled for this provider', { provider: this.id });
          this.refusalFallbackDisabled = true;
          continue;
        }
        throw this.mapError(err, request.signal, apiKey);
      }
    }

    try {
      yield* this.translate(stream, request);
    } catch (err) {
      throw this.mapError(err, request.signal, apiKey);
    }
  }

  private useRefusalFallback(model: string): boolean {
    return this.refusalFallbackWanted && !this.refusalFallbackDisabled && REFUSAL_FALLBACK_MODELS.has(model);
  }

  private buildParams(request: ChatRequest, messages: BetaMessageParam[]): BetaMessageCreateParamsStreaming {
    const current = isCurrentClaudeModel(request.model);
    const params: BetaMessageCreateParamsStreaming = {
      model: request.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      stream: true,
      // Automatic caching of the stable prefix (system + tools + earlier turns).
      cache_control: { type: 'ephemeral' },
    };
    const system = systemWithJsonInstruction(request.system, request.responseFormat === 'json');
    if (system) params.system = system;
    if (current) {
      params.thinking = { type: 'adaptive', display: 'summarized' };
      const effort = effortFor(request.reasoning);
      if (effort) params.output_config = { effort };
    } else if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }
    if (request.tools?.length) {
      params.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as { type: 'object'; [k: string]: unknown },
        eager_input_streaming: true,
      }));
      // `auto` is the default; forced tool choice is never sent (current models reject it).
      if (request.toolChoice === 'none') params.tool_choice = { type: 'none' };
    }
    if (request.webSearch && this.capabilities(request.model).nativeWebSearch) {
      params.tools = [...(params.tools ?? []), {
        type: 'web_search_20250305', name: 'web_search',
        ...(request.webSearch.maxUses !== undefined ? { max_uses: request.webSearch.maxUses } : {}),
      }];
    }
    return params;
  }

  /** Open the stream with pre-first-byte retries; resolves when the response headers arrived. */
  private open(
    sdk: Anthropic,
    params: BetaMessageCreateParamsStreaming,
    fallback: boolean,
    signal: AbortSignal | undefined,
  ): Promise<AsyncIterable<BetaRawMessageStreamEvent>> {
    const attempt = async (): Promise<AsyncIterable<BetaRawMessageStreamEvent>> => {
      if (fallback) {
        return sdk.beta.messages.create({ ...params, betas: [REFUSAL_FALLBACK_BETA], fallbacks: 'default' }, { signal });
      }
      // Same wire shape; the beta types are a superset of the GA ones for the fields we send.
      return sdk.messages.create(params as unknown as MessageCreateParamsStreaming, { signal }) as unknown as Promise<
        AsyncIterable<BetaRawMessageStreamEvent>
      >;
    };
    return retryBeforeFirstByte(
      attempt,
      (outcome) => {
        if (outcome.ok) return { retry: false };
        const err = outcome.error;
        if (err instanceof RateLimitError || err instanceof InternalServerError) {
          return { retry: true, retryAfterMs: parseRetryAfter(err.headers?.get('retry-after')) };
        }
        if (err instanceof APIConnectionError) return { retry: true };
        return { retry: false };
      },
      { signal, sleep: this.options.sleep },
    );
  }

  /** Translate raw stream events into NEO events. */
  private async *translate(stream: AsyncIterable<BetaRawMessageStreamEvent>, request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    type Block =
      | { kind: 'text'; data: Record<string, unknown> }
      | { kind: 'thinking'; text: string; signature: string }
      | { kind: 'redacted'; data: string }
      | { kind: 'tool'; id: string; name: string; json: string }
      | { kind: 'server'; data: Record<string, unknown>; json: string }
      | { kind: 'other' };
    const blocks = new Map<number, Block>();
    const replayBlocks = new Map<number, Record<string, unknown>>();
    const sources: Source[] = [];
    const nativeSearch = !!request.webSearch && this.capabilities(request.model).nativeWebSearch === true;
    /**
     * Tool calls are released at the end of the message: a refusal means the turn's tool calls
     * must not run, and a server-side fallback discards calls made before its marker. Reasoning
     * parts are emitted as their blocks end, because the runtime places parts in arrival order
     * (a thinking block from a model that then declined mid-stream cannot be taken back; the API
     * drops thinking a model cannot read).
     */
    let toolCalls: ChatStreamEvent[] = [];
    let stopReason: StopReason = 'end';
    let sawText = false;
    let finished = false;
    let input = 0;
    let output = 0;
    let cacheRead: number | null = null;
    let cacheWrite: number | null = null;
    let thinkingTokens: number | null = null;

    for await (const event of stream) {
      throwIfAborted(request.signal);
      switch (event.type) {
        case 'message_start': {
          const u = event.message.usage;
          input = u.input_tokens ?? 0;
          output = u.output_tokens ?? 0;
          cacheRead = u.cache_read_input_tokens ?? null;
          cacheWrite = u.cache_creation_input_tokens ?? null;
          break;
        }
        case 'content_block_start': {
          const b = event.content_block;
          if (nativeSearch && ['text', 'thinking', 'redacted_thinking', 'tool_use', 'server_tool_use', 'web_search_tool_result'].includes(b.type)) {
            replayBlocks.set(event.index, { ...b });
          }
          if (b.type === 'text') {
            blocks.set(event.index, { kind: 'text', data: replayBlocks.get(event.index) ?? { ...b } });
            collectWebCitations(sources, b.citations);
            if (b.text) {
              sawText = true;
              yield { type: 'text', text: b.text };
            }
          } else if (b.type === 'thinking') {
            blocks.set(event.index, { kind: 'thinking', text: b.thinking ?? '', signature: b.signature ?? '' });
            if (b.thinking) yield { type: 'reasoning', text: b.thinking };
          } else if (b.type === 'redacted_thinking') {
            blocks.set(event.index, { kind: 'redacted', data: b.data });
          } else if (b.type === 'tool_use') {
            blocks.set(event.index, { kind: 'tool', id: b.id, name: b.name, json: '' });
          } else if (b.type === 'server_tool_use' || b.type === 'web_search_tool_result') {
            blocks.set(event.index, { kind: 'server', data: replayBlocks.get(event.index) ?? { ...b }, json: '' });
            if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
              for (const source of b.content) addSource(sources, source.url, source.title);
            }
          } else if (b.type === 'fallback') {
            // Server-side refusal fallback: output before this marker came from a model that declined.
            toolCalls = [];
            for (const [index, replay] of replayBlocks) if (replay['type'] === 'tool_use') replayBlocks.delete(index);
            blocks.set(event.index, { kind: 'other' });
          } else {
            blocks.set(event.index, { kind: 'other' });
          }
          break;
        }
        case 'content_block_delta': {
          const block = blocks.get(event.index);
          const d = event.delta;
          if (d.type === 'text_delta') {
            if (block?.kind === 'text') block.data['text'] = String(block.data['text'] ?? '') + d.text;
            if (d.text) {
              sawText = true;
              yield { type: 'text', text: d.text };
            }
          } else if (d.type === 'thinking_delta' && block?.kind === 'thinking') {
            block.text += d.thinking;
            if (d.thinking) yield { type: 'reasoning', text: d.thinking };
          } else if (d.type === 'signature_delta' && block?.kind === 'thinking') {
            block.signature += d.signature;
          } else if (d.type === 'input_json_delta' && block?.kind === 'tool') {
            block.json += d.partial_json;
          } else if (d.type === 'input_json_delta' && block?.kind === 'server') {
            block.json += d.partial_json;
          } else if (d.type === 'citations_delta') {
            collectWebCitations(sources, [d.citation]);
            if (block?.kind === 'text') {
              const citations = Array.isArray(block.data['citations']) ? block.data['citations'] : [];
              block.data['citations'] = [...citations, d.citation];
            }
          }
          break;
        }
        case 'content_block_stop': {
          const block = blocks.get(event.index);
          const replay = replayBlocks.get(event.index);
          if (block?.kind === 'thinking') {
            if (replay) {
              replay['thinking'] = block.text;
              replay['signature'] = block.signature;
            }
            yield {
              type: 'reasoning_part',
              part: {
                type: 'reasoning',
                text: block.text,
                provider: 'anthropic',
                model: request.model,
                data: { type: 'thinking', signature: block.signature },
              },
            };
          } else if (block?.kind === 'redacted') {
            yield {
              type: 'reasoning_part',
              part: { type: 'reasoning', text: '', provider: 'anthropic', model: request.model, redacted: true, data: { type: 'redacted_thinking', data: block.data } },
            };
          } else if (block?.kind === 'tool') {
            if (replay && block.json) replay['input'] = parseToolInput(block.json);
            toolCalls.push({ type: 'tool_call', id: block.id, name: block.name, input: parseToolInput(block.json) });
          } else if (block?.kind === 'server' && block.json) {
            block.data['input'] = parseToolInput(block.json);
          }
          break;
        }
        case 'message_delta': {
          stopReason = mapStopReason(event.delta.stop_reason);
          const u = event.usage;
          // message_delta usage is cumulative: it supersedes message_start where present.
          if (typeof u.input_tokens === 'number') input = u.input_tokens;
          if (typeof u.output_tokens === 'number') output = u.output_tokens;
          if (typeof u.cache_read_input_tokens === 'number') cacheRead = u.cache_read_input_tokens;
          if (typeof u.cache_creation_input_tokens === 'number') cacheWrite = u.cache_creation_input_tokens;
          const details = (u as { output_tokens_details?: { thinking_tokens?: number } | null }).output_tokens_details;
          if (typeof details?.thinking_tokens === 'number') thinkingTokens = details.thinking_tokens;
          break;
        }
        case 'message_stop':
          finished = true;
          break;
      }
    }

    // The SDK ends the iteration quietly when the request is aborted.
    throwIfAborted(request.signal);
    if (!finished) {
      throw new NeoError('provider_error', 'The connection to Anthropic closed before the response finished.', { retryable: true });
    }

    if (stopReason !== 'refusal') yield* toolCalls;
    if (nativeSearch && replayBlocks.size) {
      const content = [...replayBlocks].sort(([a], [b]) => a - b).map(([, block]) => block).filter(block => stopReason !== 'refusal' || block['type'] !== 'tool_use');
      yield { type: 'provider_part', part: { type: 'provider_part', provider: 'anthropic', model: request.model, data: { type: 'native_search_message', content } } };
    }
    if (stopReason === 'refusal' && !sawText) yield { type: 'text', text: REFUSAL_NOTE };
    if (sources.length) yield { type: 'sources', items: sources };
    yield { type: 'usage', usage: makeUsage(input, output, { cacheRead, cacheWrite, reasoning: thinkingTokens }) };
    yield { type: 'done', stopReason };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const apiKey = this.apiKey();
    const sdk = this.sdk(apiKey);
    try {
      const models: ModelInfo[] = [];
      for await (const m of sdk.models.list({ limit: 100 }, { signal })) {
        if (!m || typeof m.id !== 'string' || !m.id) continue;
        if (redact(m.id, [apiKey]) !== m.id) throw new NeoError('provider_error', 'Anthropic returned invalid model data.');
        if (m.lifecycle === 'retired') continue;
        const fallback = this.capabilities(m.id);
        const caps = m.capabilities;
        models.push({
          id: m.id,
          provider: this.id,
          label: redact(typeof m.display_name === 'string' && m.display_name ? m.display_name : m.id, [apiKey]),
          capabilities: {
            ...fallback,
            vision: caps ? caps.image_input.supported : fallback.vision,
            reasoning: caps ? caps.thinking.supported : fallback.reasoning,
            contextWindow: m.max_input_tokens ?? fallback.contextWindow,
            maxOutputTokens: m.max_tokens ?? fallback.maxOutputTokens,
          },
        });
      }
      return models;
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof TypeError) throw new NeoError('provider_error', 'Anthropic returned invalid model data.');
      throw this.mapError(err, signal, apiKey);
    }
  }

  test(signal?: AbortSignal): Promise<ProviderTestResult> {
    return testByListingModels(() => this.listModels(signal));
  }

  private apiKey(): string {
    const key = resolveApiKey(this.config, this.options);
    if (!key) throw missingKeyError(this.config);
    return key;
  }

  /** One SDK client per key (a key saved later in the SecretStore gets a fresh client). */
  private sdk(apiKey: string): Anthropic {
    if (this.client?.key !== apiKey) {
      this.client = {
        key: apiKey,
        sdk: new Anthropic({
          apiKey,
          // Explicit values so ANTHROPIC_* environment variables never leak into a configured provider.
          authToken: null,
          baseURL: this.baseUrl,
          maxRetries: 0,
          logLevel: 'off',
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
          ...(this.config.headers ? { defaultHeaders: this.config.headers } : {}),
        }),
      };
    }
    return this.client.sdk;
  }

  /** Redact the API key and credential-looking custom headers from user-visible text. */
  private clean(text: string, apiKey: string): string {
    const secrets: (string | undefined)[] = [apiKey];
    for (const [name, value] of Object.entries(this.config.headers ?? {})) {
      if (/auth|key|token|secret/i.test(name)) secrets.push(value, value.replace(/^bearer\s+/i, ''));
    }
    return redact(text, secrets);
  }

  /** SDK errors → NeoError (docs/PROVIDERS.md "Errors"); credentials are redacted from messages. */
  private mapError(err: unknown, signal: AbortSignal | undefined, apiKey: string): NeoError {
    if (err instanceof APIUserAbortError) return cancelledError(err);
    const cancelled = asCancelled(err, signal);
    if (cancelled) return cancelled;
    if (err instanceof NeoError) return err;
    if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
      return new NeoError('provider_auth', this.clean(`Anthropic rejected the API key: ${apiMessage(err)}`, apiKey), { cause: err });
    }
    if (err instanceof RateLimitError) {
      const retryAfterMs = parseRetryAfter(err.headers?.get('retry-after'));
      return new NeoError('rate_limited', this.clean(`Anthropic rate limit: ${apiMessage(err)}`, apiKey), {
        retryable: true,
        ...(retryAfterMs !== undefined ? { details: { retryAfterMs } } : {}),
        cause: err,
      });
    }
    if (err instanceof APIConnectionError) {
      return new NeoError('provider_error', this.clean(`Can't reach Anthropic at ${hostOf(this.baseUrl)}: ${describeNetworkError(err.cause ?? err)}`, apiKey), {
        retryable: true,
        cause: err,
      });
    }
    if (err instanceof APIError) {
      const type = apiErrorType(err);
      const message = this.clean(`Anthropic error: ${apiMessage(err)}`, apiKey);
      // Errors inside an already-open stream carry no HTTP status, only an error type.
      if (type === 'rate_limit_error') return new NeoError('rate_limited', message, { retryable: true, cause: err });
      const streamFailure = err.status === undefined && (type === 'overloaded_error' || type === 'api_error');
      const retryable = err instanceof InternalServerError || streamFailure;
      return new NeoError('provider_error', message, { retryable, cause: err });
    }
    const neo = NeoError.from(err, 'provider_error');
    return new NeoError(neo.code, this.clean(neo.message, apiKey), { retryable: neo.retryable, cause: err });
  }
}

function collectWebCitations(sources: Source[], citations: unknown): void {
  if (!Array.isArray(citations)) return;
  for (const citation of citations) {
    if (!isPlainObject(citation) || citation['type'] !== 'web_search_result_location') continue;
    addSource(sources, citation['url'], citation['title'], citation['cited_text']);
  }
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      // end_turn, stop_sequence, pause_turn, compaction
      return 'end';
  }
}
