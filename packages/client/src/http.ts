/**
 * Low-level HTTP request helper for the NEO API.
 *
 * Handles: base-URL + /api prefix, Bearer token, JSON bodies, query encoding
 * (comma-separated arrays, boolean strings), 204 no-content, per-request
 * timeout via AbortSignal.any (with fallback), and NeoApiError mapping.
 */
import { NeoError, type ErrorShape } from '@neo/protocol';
import { NeoApiError } from './errors.js';

// ─────────────────────────────────────────────────────────────────────────────

/** Encode a query-param value: arrays → comma-separated, booleans → 'true'/'false'. */
function encodeValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    return v.map((item) => String(item)).join(',');
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/** Build URLSearchParams from a flat object, skipping undefined/null. */
export function buildQuery(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    const encoded = encodeValue(v);
    if (encoded !== null) q.set(k, encoded);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

// ─────────────────────────────────────────────────────────────────────────────

export interface RequestOptions {
  method?: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Extra headers (e.g. Accept: text/event-stream). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** If false, don't apply a timeout (e.g. streaming). Default: true. */
  timeout?: boolean;
}

export interface HttpContext {
  baseUrl: string;
  token: string | undefined;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}

/**
 * Make an API call and return the parsed JSON response.
 * 204 responses return `undefined`.
 * Non-2xx responses throw `NeoApiError`.
 * Network failures throw `NeoApiError` with code 'internal' and retryable=true.
 */
export async function apiRequest<T>(ctx: HttpContext, opts: RequestOptions): Promise<T> {
  const { method = 'GET', path, query, body, headers: extraHeaders, signal, timeout = true } = opts;

  const url = `${ctx.baseUrl}/api${path}${buildQuery(query)}`;

  const headers: Record<string, string> = { ...extraHeaders };
  if (ctx.token) headers['Authorization'] = `Bearer ${ctx.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // Build a combined signal with timeout when requested.
  let combinedSignal: AbortSignal | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  if (signal || timeout) {
    if (timeout) {
      // AbortSignal.any is available in modern browsers and Node ≥ 22.
      // Provide a fallback for environments that don't have it yet.
      const controller = new AbortController();
      timeoutHandle = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), ctx.timeoutMs);
      const timeoutSignal = controller.signal;

      if (signal) {
        if (typeof AbortSignal.any === 'function') {
          combinedSignal = AbortSignal.any([signal, timeoutSignal]);
        } else {
          // Fallback: chain abort events manually.
          const combined = new AbortController();
          onAbort = () => combined.abort(signal.reason);
          const onTimeout = () => combined.abort(timeoutSignal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) combined.abort(signal.reason);
          timeoutSignal.addEventListener('abort', onTimeout, { once: true });
          combinedSignal = combined.signal;
        }
      } else {
        combinedSignal = timeoutSignal;
      }
    } else {
      combinedSignal = signal;
    }
  }

  // Outer try/finally ensures clearTimeout and removeEventListener always run,
  // including when ctx.fetch() itself rejects (network failure, headers-phase
  // abort, pre-aborted signal). Without this, onAbort would leak on fetch-phase
  // failures because the inner finally of the body-processing block is never
  // reached.
  let response: Response;
  try {
    try {
      response = await ctx.fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: combinedSignal,
      });
    } catch (err) {
      // Let pre-classified errors propagate unchanged (e.g. from an injected fetch).
      if (err instanceof NeoError) throw err;

      // Check for timeout/abort errors.
      if (
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError')
      ) {
        // Re-throw as NeoApiError only if it's the timeout (not a user abort).
        if (err.name === 'TimeoutError') {
          throw new NeoApiError(504, { code: 'timeout', message: 'Request timed out.', retryable: true }, { cause: err });
        }
        // User abort — let the AbortError propagate naturally (caller checks signal).
        throw err;
      }

      // Network failure.
      throw new NeoApiError(0, {
        code: 'internal',
        message: err instanceof Error ? err.message : 'Network error',
        retryable: true,
      }, { cause: err });
    }

    try {
      if (response.status === 204) {
        return undefined as unknown as T;
      }

      if (!response.ok) {
        // Try to parse the error body as ErrorShape.
        let shape: ErrorShape;
        let bodyParseErr: unknown;
        try {
          shape = (await response.json()) as ErrorShape;
          // Validate that shape has the required fields.
          if (typeof shape.code !== 'string' || typeof shape.message !== 'string') {
            throw new Error('invalid shape');
          }
        } catch (bodyErr) {
          bodyParseErr = bodyErr;
          // Let abort/timeout errors propagate to the outer catch for proper mapping.
          if (
            bodyErr instanceof Error &&
            (bodyErr.name === 'AbortError' || bodyErr.name === 'TimeoutError')
          ) {
            throw bodyErr;
          }
          shape = {
            code: 'internal',
            message: `HTTP ${response.status}`,
            retryable: response.status >= 500,
          };
        }
        throw new NeoApiError(response.status, shape, { cause: bodyParseErr });
      }

      // 202 or other 2xx with a body.
      const text = await response.text();
      if (!text) return undefined as unknown as T;
      return JSON.parse(text) as T;
    } catch (err) {
      // Let pre-classified errors propagate unchanged.
      if (err instanceof NeoError) throw err;

      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new NeoApiError(504, { code: 'timeout', message: 'Request timed out.', retryable: true }, { cause: err });
      }

      // User abort — let AbortError propagate naturally (caller checks signal).
      if (err instanceof Error && err.name === 'AbortError') throw err;

      // Any other body-read failure (e.g. TCP reset mid-body, TypeError: terminated).
      throw new NeoApiError(0, {
        code: 'internal',
        message: err instanceof Error ? err.message : 'Network error',
        retryable: true,
      }, { cause: err });
    }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}
