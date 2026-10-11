/** Input validation helpers shared by the productivity stores. */
import { NeoError } from '@neo/protocol';
import type { z } from 'zod';

/** One readable line per zod issue: "title: Too small: expected string to have >=1 characters". */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(input)'}: ${i.message}`).join('; ');
}

/** Parse `input` with `schema`; invalid input becomes NeoError('bad_request'). */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown, what: string): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new NeoError('bad_request', `Invalid ${what}: ${describeIssues(result.error)}`, { details: result.error.issues });
  }
  return result.data;
}

/** Trimmed non-empty string, or NeoError('bad_request'). */
export function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new NeoError('bad_request', `Invalid ${field}: must not be empty.`);
  return trimmed;
}

/** A safe integer LIMIT: `fallback` for missing/NaN, at least 1, at most `max`. */
export function clampLimit(limit: unknown, fallback: number, max: number): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.min(max, Math.max(1, n));
}

/** Escape a LIKE pattern fragment (use with `ESCAPE '\'`). */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** Number of rows changed by a run() result. */
export function changes(result: unknown): number {
  const n = (result as { changes?: number | bigint }).changes ?? 0;
  return typeof n === 'bigint' ? Number(n) : n;
}
