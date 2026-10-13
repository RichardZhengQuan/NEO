/** Shared parsing and past-time rule for reminder tools. */
import { NeoError } from '@neo/protocol';
import { parseDateTime } from '../time.js';
import { localIso } from './format.js';

/** Times this far in the past are rejected (they would fire immediately as "missed"). */
export const PAST_TOLERANCE_MS = 60_000;

export const WHEN_HELP =
  'When to fire: a phrase like "in 10 minutes", "in 2 hours", "tomorrow 9am", "tonight", "friday 14:00", "today 18:30", ' +
  'an ISO time ("2026-10-12T09:00", local time when there is no offset) or epoch ms.';

export function parseFuture(when: string | number, now: number, timezone: string): number {
  const dueAt = parseDateTime(when, now, timezone);
  if (dueAt < now - PAST_TOLERANCE_MS) {
    throw new NeoError('bad_request', `That time (${localIso(dueAt, timezone)} ${timezone}) is in the past; it is now ${localIso(now, timezone)}. Pick a future time.`);
  }
  return dueAt;
}
