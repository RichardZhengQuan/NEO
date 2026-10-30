import { NeoError } from '@neo/protocol';
import { loadConfig } from '@neo/server';
import { describe, expect, it } from 'vitest';
import { safeConfigDiagnostic } from './config-diagnostic.js';

const reason = 'Each tunnel.advertise entry must be a host:port address';
const marker = 'DO_NOT_PRINT_CONFIG_SECRET';

function validationError(field: string, message: string): NeoError {
  return new NeoError('bad_request', 'Validation failed.', {
    details: { errors: [marker], properties: {
      tunnel: { errors: [], properties: {
        [field]: { errors: [], items: [{ errors: [message], input: marker }] },
      } },
    } },
    cause: new Error(marker),
  });
}

describe('safe CLI config diagnostics', () => {
  it('exposes only the fixed field and known reason without mutating the shared error', () => {
    const error = validationError('advertise', reason);
    const before = error.toJSON();
    expect(safeConfigDiagnostic(error)).toBe(`Invalid configuration: tunnel.advertise: ${reason}`);
    expect(safeConfigDiagnostic(error)).not.toContain(marker);
    expect(error.toJSON()).toEqual(before);
    expect(error.message).toBe('Validation failed.');
  });

  it.each([
    validationError('advertise', marker),
    validationError(marker, reason),
    new NeoError('bad_request', 'Validation failed.', { details: marker }),
    new NeoError('config_error', 'Validation failed.', { details: validationError('advertise', reason).details }),
    new Error(marker),
    marker,
    null,
  ])('does not format unknown errors, paths or validation messages (%#)', (error) => {
    expect(safeConfigDiagnostic(error)).toBeUndefined();
  });

  it('recognizes actual config validation while leaving a valid host:port unchanged', () => {
    let error: unknown;
    try {
      loadConfig({ env: {}, overrides: { tunnel: { advertise: ['192.0.2.10'] } } });
    } catch (caught) {
      error = caught;
    }
    expect(safeConfigDiagnostic(error)).toBe(`Invalid configuration: tunnel.advertise: ${reason}`);
    expect(loadConfig({ env: {}, overrides: { tunnel: { advertise: ['192.0.2.10:7778'] } } }).tunnel.advertise)
      .toEqual(['192.0.2.10:7778']);
  });
});
