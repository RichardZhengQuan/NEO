/**
 * Wall-clock ↔ instant conversions in an IANA timezone (no dependencies).
 *
 * Reminders live in the user's timezone (settings.timezone), which may differ
 * from the device's. <input type="datetime-local"> gives wall time, so we
 * convert explicitly instead of trusting `new Date(string)`.
 */

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function validTz(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return tz;
  } catch {
    return undefined;
  }
}

export function wallTimeOf(ms: number, timeZone?: string): WallTime {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: validTz(timeZone),
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(ms);
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: num('year'),
    month: num('month'),
    day: num('day'),
    hour: num('hour') % 24,
    minute: num('minute'),
    weekday: WEEKDAY[parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'] ?? 0,
  };
}

/** Offset (ms) of `timeZone` from UTC at instant `ms`. */
function offsetAt(ms: number, timeZone?: string): number {
  const w = wallTimeOf(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

/** The instant at which the wall clock in `timeZone` shows the given time. DST gaps resolve forward. */
export function instantOf(year: number, month: number, day: number, hour: number, minute: number, timeZone?: string): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let guess = naive - offsetAt(naive, timeZone);
  // Two refinements settle DST transitions.
  for (let i = 0; i < 2; i++) {
    const next = naive - offsetAt(guess, timeZone);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-10-10T17:30" for <input type="datetime-local">. */
export function toLocalInputValue(ms: number, timeZone?: string): string {
  const w = wallTimeOf(ms, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/** Parse a datetime-local value as wall time in `timeZone`. Returns null when invalid. */
export function fromLocalInputValue(value: string, timeZone?: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return instantOf(y, mo, d, h, mi, timeZone);
}

/** "2026-10-10" for <input type="date">. */
export function toDateInputValue(ms: number, timeZone?: string): string {
  return toLocalInputValue(ms, timeZone).slice(0, 10);
}

/** Start of the given date (YYYY-MM-DD) in `timeZone`, or null. */
export function fromDateInputValue(value: string, timeZone?: string, hour = 9): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  return instantOf(Number(m[1]), Number(m[2]), Number(m[3]), hour, 0, timeZone);
}

/** Next occurrence of hh:mm in `timeZone` after `now` (today or tomorrow). */
export function nextTimeOfDay(hour: number, minute: number, now: number, timeZone?: string): number {
  const w = wallTimeOf(now, timeZone);
  const today = instantOf(w.year, w.month, w.day, hour, minute, timeZone);
  if (today > now) return today;
  const tomorrow = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
  return instantOf(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hour, minute, timeZone);
}

/** hh:mm tomorrow (calendar day after `now`) in `timeZone`. */
export function tomorrowAt(hour: number, minute: number, now: number, timeZone?: string): number {
  const w = wallTimeOf(now, timeZone);
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
  return instantOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute, timeZone);
}

/** The device's timezone. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const FALLBACK_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Cairo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
];

export function listTimeZones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone');
    if (supported && supported.length) return supported.includes('UTC') ? supported : ['UTC', ...supported];
  } catch {
    // fall through
  }
  return FALLBACK_ZONES;
}
