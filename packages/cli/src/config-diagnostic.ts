import { NeoError } from '@neo/protocol';

const ADVERTISE_REASON = 'Each tunnel.advertise entry must be a host:port address';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Only expose known schema text, never arbitrary validation messages or values. */
export function safeConfigDiagnostic(error: unknown): string | undefined {
  if (!(error instanceof NeoError) || error.code !== 'bad_request' || error.message !== 'Validation failed.') return;
  const properties = record(record(error.details)?.['properties']);
  const tunnel = record(properties?.['tunnel']);
  const tunnelProperties = record(tunnel?.['properties']);
  const advertise = record(tunnelProperties?.['advertise']);
  const items = advertise?.['items'];
  if (!Array.isArray(items)) return;
  if (items.some((item: unknown) => {
    const errors = record(item)?.['errors'];
    return Array.isArray(errors) && errors.includes(ADVERTISE_REASON);
  })) {
    return `Invalid configuration: tunnel.advertise: ${ADVERTISE_REASON}`;
  }
}
