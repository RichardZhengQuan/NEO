/**
 * Helpers shared by the adapters: API-key resolution, secret redaction,
 * cancellation, retry-after parsing, tool-input parsing and request ids.
 */
import { randomUUID } from 'node:crypto';
import { NeoError, PROVIDER_PRESETS, SourceSchema, isAbortError } from '@neo/protocol';
import type { ChatRequest, ProviderConfig, ProviderTestResult, Source, Usage } from '@neo/protocol';
import type { ProviderOptions } from './index.js';

/** `config.apiKey ?? resolveSecret(config.apiKeySecret)`, resolved on every call so a key saved later is picked up. */
export function resolveApiKey(config: ProviderConfig, options: ProviderOptions): string | undefined {
  if (config.apiKey) return config.apiKey;
  if (config.apiKeySecret && options.resolveSecret) return options.resolveSecret(config.apiKeySecret) || undefined;
  return undefined;
}

/** True when `headers` (from config.headers) already carry one of the given auth headers. */
export function hasHeader(headers: Record<string, string> | undefined, ...names: string[]): boolean {
  if (!headers) return false;
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  return Object.entries(headers).some(([k, v]) => wanted.has(k.toLowerCase()) && Boolean(v));
}

/** The friendly provider_auth error for a provider whose preset needs a key. */
export function missingKeyError(config: ProviderConfig): NeoError {
  const preset = PROVIDER_PRESETS[config.kind];
  const where = preset?.keyUrl ? ` You can create one at ${preset.keyUrl}.` : '';
  return new NeoError('provider_auth', `${preset?.label ?? config.label ?? config.id} needs an API key. Add it in Settings → Providers.${where}`, {
    details: { provider: config.id },
  });
}

/** Replace every occurrence of the given secrets (API keys) in `text`. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('[redacted]');
  }
  return out;
}

export function cancelledError(cause?: unknown): NeoError {
  return new NeoError('cancelled', 'The operation was cancelled.', cause === undefined ? {} : { cause });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError(signal.reason);
}

/** Map abort-shaped errors (or any error after the signal fired) to NeoError('cancelled'). */
export function asCancelled(err: unknown, signal: AbortSignal | undefined): NeoError | null {
  if (err instanceof NeoError) return err.code === 'cancelled' ? err : signal?.aborted ? cancelledError(err) : null;
  if (signal?.aborted || isAbortError(err)) return cancelledError(err);
  return null;
}

/** Race `promise` against `signal`; rejects with NeoError('cancelled') if signal fires first. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelledError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/** A timer that rejects with NeoError('cancelled') as soon as `signal` aborts. */
export const abortableSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError(signal.reason));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Run any sleep implementation, but stop waiting (with NeoError('cancelled')) when `signal` aborts. */
export function sleepUnlessAborted(sleep: SleepFn, ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep(ms);
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(cancelledError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<void>;
    try {
      pending = sleep(ms, signal);
    } catch (err) {
      signal.removeEventListener('abort', onAbort);
      reject(err);
      return;
    }
    pending.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(asCancelled(err, signal) ?? err);
      },
    );
  });
}

/** `Retry-After` (seconds or HTTP date) in milliseconds; undefined when absent or unparseable. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Parse accumulated tool-call JSON. Invalid or truncated JSON becomes `{ __invalid_json: raw }` so the registry rejects it. */
export function parseToolInput(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { __invalid_json: raw };
  }
}

/**
 * Build a set of tool names whose input schemas were wrapped by `ensureObjectSchema`
 * (i.e. had a non-object root). The model returns `{value: <actual>}` for these
 * tools, so callers must strip the wrapper before handing inputs to registry.execute.
 */
export function wrappedToolSet(tools: readonly { name: string; inputSchema: Record<string, unknown> }[] | undefined): Set<string> {
  if (!tools?.length) return new Set();
  return new Set(tools.filter((t) => t.inputSchema['type'] !== 'object').map((t) => t.name));
}

/**
 * Strip the `{value: <actual>}` wrapper that `ensureObjectSchema` added at the
 * provider boundary, but only for tools whose schema was actually wrapped.
 */
export function unwrapToolInput(input: unknown, toolName: string, wrapped: Set<string>): unknown {
  if (!wrapped.has(toolName) || !isPlainObject(input) || !('value' in input)) return input;
  return (input as Record<string, unknown>)['value'];
}

/** A unique id for tool calls whose provider did not supply one. */
export function newCallId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** request.reasoning → the low/medium/high knob (`off` keeps the lightest setting). */
export function effortFor(reasoning: ChatRequest['reasoning']): 'low' | 'medium' | 'high' | undefined {
  switch (reasoning) {
    case 'off':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    default:
      return undefined;
  }
}

/** The instruction used for `responseFormat: 'json'` on providers without a native JSON switch. */
export const JSON_INSTRUCTION = 'Respond with a single JSON object only.';

export function systemWithJsonInstruction(system: string | undefined, json: boolean): string | undefined {
  if (!json) return system || undefined;
  return system ? `${system}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION;
}

/** Short note streamed when a model refuses without producing any text. */
export const REFUSAL_NOTE = "I can't help with that request.";

/** A Usage object without undefined optional fields. */
export function makeUsage(input: number, output: number, extra: { cacheRead?: number | null; cacheWrite?: number | null; reasoning?: number | null } = {}): Usage {
  const usage: Usage = { inputTokens: Math.max(0, input), outputTokens: Math.max(0, output) };
  if (typeof extra.cacheRead === 'number') usage.cacheReadTokens = extra.cacheRead;
  if (typeof extra.cacheWrite === 'number') usage.cacheWriteTokens = extra.cacheWrite;
  if (typeof extra.reasoning === 'number') usage.reasoningTokens = extra.reasoning;
  return usage;
}

/** Shared implementation of `ProviderAdapter.test()`: list models and time it. */
export async function testByListingModels(list: () => Promise<{ id: string }[]>): Promise<ProviderTestResult> {
  const start = performance.now();
  try {
    const models = await list();
    return { ok: true, latencyMs: Math.round(performance.now() - start), models: models.map((m) => m.id) };
  } catch (err) {
    const neo = NeoError.from(err, 'provider_error');
    return { ok: false, latencyMs: Math.round(performance.now() - start), error: neo.message };
  }
}

/** JSON parser errors can include upstream body excerpts; model discovery never reflects them. */
export async function readModelData(response: Response, label: string, field: 'data' | 'models', signal?: AbortSignal): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throwIfAborted(signal);
    throw new NeoError('provider_error', `${label} returned invalid model data.`);
  }
  if (!isPlainObject(value) || !Array.isArray(value[field])) throw new NeoError('provider_error', `${label} returned invalid model data.`);
  return value;
}

/** Plain JSON object check (tool inputs must be objects for most providers). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bound and validate untrusted upstream links before they become timeline sources. */
export function addSource(sources: Source[], url: unknown, title: unknown, snippet?: unknown): void {
  if (typeof url !== 'string' || sources.length >= 100) return;
  const result = SourceSchema.safeParse({
    url,
    title: typeof title === 'string' && title.trim() ? title.slice(0, 1000) : url.slice(0, 1000),
    ...(typeof snippet === 'string' && snippet ? { snippet: snippet.slice(0, 4000) } : {}),
  });
  if (!result.success) return;
  const existing = sources.find(source => source.url === result.data.url);
  if (existing) {
    if (existing.title === existing.url && result.data.title !== result.data.url) existing.title = result.data.title;
    if (!existing.snippet && result.data.snippet) existing.snippet = result.data.snippet;
  } else sources.push(result.data);
}

/** Hostname of a URL for messages ("Can't reach api.example.com"); falls back to the raw string. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Describe a fetch failure ("fetch failed" → its cause, e.g. "connect ECONNREFUSED 127.0.0.1:11434"). */
export function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return cause.message;
  if (cause && typeof cause === 'object' && 'code' in cause) return String((cause as { code: unknown }).code);
  return err.message;
}
