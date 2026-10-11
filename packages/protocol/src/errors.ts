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
