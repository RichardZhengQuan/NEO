/**
 * Shared route helpers.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { NeoError } from '@neo/protocol';

/** Validate request body; return 400 with treeifyError details on failure. */
export async function validateBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new NeoError('bad_request', 'Invalid JSON body');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new NeoError('bad_request', 'Validation failed', { details: z.treeifyError(result.error) });
  }
  return result.data;
}

/** Validate query params; return 400 with treeifyError details on failure. */
export function validateQuery<T>(c: Context, schema: z.ZodType<T>): T {
  const raw = c.req.query();
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new NeoError('bad_request', 'Invalid query params', { details: z.treeifyError(result.error) });
  }
  return result.data;
}

/** Parse comma-separated string into an array of trimmed, non-empty strings. */
export function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

/** Parse a boolean query param (true/1 → true, false/0 → false, undefined → undefined). */
export function parseBool(value: string | undefined): boolean | undefined {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

export const queryBoolean = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
export const queryNumber = z.string().min(1).transform(Number).pipe(z.number().finite());
export const queryLimit = queryNumber.pipe(z.number().int().min(1).max(500));

/** A typed comma-separated list; invalid members retain zod's query details. */
export function queryList<T>(schema: z.ZodType<T>) {
  return z.preprocess((value) => typeof value === 'string' ? parseList(value) ?? [] : value, z.array(schema));
}
