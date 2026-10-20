/**
 * NeoApiError — thrown for non-2xx HTTP responses from the NEO server.
 */
import { NeoError, type ErrorShape } from '@neo/protocol';

/** Thrown for non-2xx responses; mirrors the server's ErrorShape. */
export class NeoApiError extends NeoError {
  readonly httpStatus: number;
  constructor(httpStatus: number, shape: ErrorShape, options: { cause?: unknown } = {}) {
    super(shape.code, shape.message, { details: shape.details, retryable: shape.retryable ?? false, cause: options.cause });
    this.name = 'NeoApiError';
    this.httpStatus = httpStatus;
  }
}
