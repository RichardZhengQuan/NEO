/**
 * Pre-first-byte retries (docs/PROVIDERS.md, "Streaming contract").
 *
 * Retries 429, 5xx and network failures up to 2 times with a 0.5 s then 1.5 s
 * backoff, honoring a server `retry-after` of at most 10 s (a longer one is
 * returned to the caller, who reports it as `rate_limited` with
 * `details.retryAfterMs`). Other 4xx are never retried, and nothing is retried
 * once a response body has started streaming: callers only wrap the step that
 * ends when the response headers arrive. Backoff waits stop immediately when
 * the request's AbortSignal fires.
 */
import { NeoError } from '@neo/protocol';
import { abortableSleep, asCancelled, describeNetworkError, parseRetryAfter, sleepUnlessAborted, throwIfAborted, type SleepFn } from './shared.js';

const BACKOFFS_MS = [500, 1500] as const;
const MAX_RETRY_AFTER_MS = 10_000;

/** What to do after one attempt. `retryAfterMs` is the server's request, if it made one. */
export type RetryDecision = { retry: false } | { retry: true; retryAfterMs?: number | undefined };

export interface RetryLoopOptions {
  /** At most 2 (the contract); default 2. */
  maxRetries?: number;
  sleep?: SleepFn;
  signal?: AbortSignal | undefined;
}

/**
 * Generic loop: `attempt` resolves (a response) or rejects (an error); `decide`
 * classifies the outcome. Returns the last value, or rethrows the last error.
 */
export async function retryBeforeFirstByte<T>(
  attempt: (attemptIndex: number) => Promise<T>,
  decide: (outcome: { ok: true; value: T } | { ok: false; error: unknown }) => RetryDecision | Promise<RetryDecision>,
  options: RetryLoopOptions & { discard?: (value: T) => void } = {},
): Promise<T> {
  const maxRetries = Math.min(Math.max(options.maxRetries ?? 2, 0), BACKOFFS_MS.length);
  const sleep = options.sleep ?? abortableSleep;
  const { signal } = options;

  for (let i = 0; ; i++) {
    throwIfAborted(signal);
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await attempt(i) };
    } catch (error) {
      const cancelled = asCancelled(error, signal);
      if (cancelled) throw cancelled;
      outcome = { ok: false, error };
    }
    const decision = await decide(outcome);
    const delay = decision.retry ? (decision.retryAfterMs ?? BACKOFFS_MS[i] ?? BACKOFFS_MS[BACKOFFS_MS.length - 1]) : undefined;
    if (delay === undefined || i >= maxRetries || delay > MAX_RETRY_AFTER_MS) {
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    }
    if (outcome.ok) options.discard?.(outcome.value);
    await sleepUnlessAborted(sleep, delay, signal);
  }
}

export interface RetryOptions {
  /** Performs one HTTP attempt (resolves when the response headers arrive). */
  attempt: (attemptIndex: number) => Promise<Response>;
  /** How many times to retry (default and maximum 2). */
  maxRetries?: number;
  /** Injected for tests: waits `ms` between attempts (default: an abortable timer). */
  sleep?: (ms: number) => Promise<void>;
  /** AbortSignal for the whole operation; aborting also interrupts the backoff wait. */
  signal?: AbortSignal;
}

/**
 * fetch with pre-first-byte retries. Returns the final Response (possibly a
 * non-OK one for the caller to map); throws NeoError('cancelled') on abort and
 * a retryable NeoError('provider_error') when the network keeps failing.
 */
export async function withRetry(opts: RetryOptions): Promise<Response> {
  try {
    return await retryBeforeFirstByte(
      opts.attempt,
      (outcome) => {
        if (!outcome.ok) return { retry: true };
        const { status } = outcome.value;
        if (status === 429 || status >= 500) return { retry: true, retryAfterMs: parseRetryAfter(outcome.value.headers.get('retry-after')) };
        return { retry: false };
      },
      {
        maxRetries: opts.maxRetries,
        sleep: opts.sleep,
        signal: opts.signal,
        // The body of a response we are not going to use would otherwise keep its connection busy.
        discard: (resp) => void resp.body?.cancel().catch(() => {}),
      },
    );
  } catch (err) {
    if (err instanceof NeoError) throw err;
    throw new NeoError('provider_error', `Network error: ${describeNetworkError(err)}`, { retryable: true, cause: err });
  }
}
