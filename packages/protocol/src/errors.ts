import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'provider_error',
  'provider_auth',
  'stream_read_failed',
  'bad_upstream',
  'search_unavailable',
  'no_provider',
  'tool_error',
  'tool_denied',
  'cancelled',
  'timeout',
  'config_error',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** Wire shape of an error (HTTP bodies, WS events, persisted message errors). */
export const ErrorShapeSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
  retryable: z.boolean().optional(),
});
export type ErrorShape = z.infer<typeof ErrorShapeSchema>;

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  provider_error: 502,
  provider_auth: 502,
  stream_read_failed: 500,
  bad_upstream: 502,
  search_unavailable: 502,
  no_provider: 400,
  tool_error: 500,
  tool_denied: 403,
  cancelled: 499,
  timeout: 504,
  config_error: 500,
  internal: 500,
};

export function httpStatusForCode(code: ErrorCode): number {
  return STATUS[code];
}

/** The one error class NEO code throws across package boundaries. */
export class NeoError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: { details?: unknown; retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NeoError';
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? (code === 'rate_limited' || code === 'timeout');
  }

  get status(): number {
    return httpStatusForCode(this.code);
  }

  toJSON(): ErrorShape {
    const out: ErrorShape = { code: this.code, message: this.message };
    if (this.details !== undefined) out.details = this.details;
    if (this.retryable) out.retryable = true;
    return out;
  }

  /** Normalize anything thrown into a NeoError (AbortError → cancelled). */
  static from(err: unknown, fallback: ErrorCode = 'internal'): NeoError {
    if (err instanceof NeoError) return err;
    if (isAbortError(err)) return new NeoError('cancelled', 'The operation was cancelled.', { cause: err });
    if (err instanceof z.ZodError) {
      return new NeoError('bad_request', 'Validation failed.', { details: z.treeifyError(err), cause: err });
    }
    if (err instanceof Error) return new NeoError(fallback, err.message, { cause: err });
    return new NeoError(fallback, typeof err === 'string' ? err : 'Unknown error');
  }

  static fromShape(shape: ErrorShape): NeoError {
    return new NeoError(shape.code, shape.message, { details: shape.details, retryable: shape.retryable ?? false });
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    ((err as { name: unknown }).name === 'AbortError' || (err as { name: unknown }).name === 'TimeoutError')
  );
}

/** Only known codes are exposed; upstream error messages may contain credentials. */
export function chatgptSubscriptionError(reason: string, status?: number): NeoError {
  const details = { reason, ...(status === undefined ? {} : { status }) };
  switch (reason) {
    case 'subscription_sharing_usage_limit_exceeded':
      return new NeoError('rate_limited', "You've reached the weekly limit you set for NEO in ChatGPT.", { details, retryable: false });
    case 'subscription_sharing_usage_unavailable':
      return new NeoError('provider_error', 'ChatGPT is temporarily unavailable. Try again later.', { details, retryable: true });
    case 'subscription_sharing_user_not_eligible':
      return new NeoError('provider_auth', 'Needs ChatGPT Plus or Pro.', { details, retryable: false });
    case 'subscription_sharing_invalid_user':
    case 'invalid_grant':
      return new NeoError('provider_auth', 'Disconnected; sign in again.', { details, retryable: false });
    default:
      return new NeoError(status === 401 || status === 403 ? 'provider_auth' : status === 429 ? 'rate_limited' : 'provider_error',
        status === 401 || status === 403 ? 'Disconnected; sign in again.' : 'ChatGPT could not complete the request. Try again later.',
        { details: status === undefined ? undefined : { status }, retryable: status === 429 || (status !== undefined && status >= 500) });
  }
}
