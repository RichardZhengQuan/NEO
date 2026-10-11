/**
 * Timezone helpers and date/time parsing. No date library: wall-clock math
 * uses `Intl.DateTimeFormat#formatToParts` (formatters are cached per zone).
 */
import { NeoError } from '@neo/protocol';
import type { ZonedParts } from './index.js';

const DAY_MS = 86_400_000;
const bad = (message: string) => new NeoError('bad_request', message);

// ───────────────────────────── zones ─────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timezone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      throw bad(`Unknown timezone "${timezone}". Use an IANA name such as "Europe/Berlin" or "Asia/Shanghai".`);
    }
    if (formatters.size > 500) formatters.clear();
    formatters.set(timezone, fmt);
  }
  return fmt;
}

/** True when `timezone` is an IANA zone (or alias) this runtime knows. */
export function isValidTimeZone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || !timezone) return false;
  try {
    formatterFor(timezone);
    return true;
  } catch {
    return false;
  }
}

/** Throw NeoError('bad_request') unless `timezone` is a known IANA zone. */
export function assertTimeZone(timezone: unknown): string {
  if (typeof timezone !== 'string' || !timezone) throw bad('A timezone is required.');
  formatterFor(timezone);
  return timezone;
}

/** Days since 1970-01-01 of a proleptic Gregorian calendar date (month 1-12; overflow normalizes). */
export function dayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

/** Inverse of {@link dayNumber}. weekday: 0 = Sunday. */
export function fromDayNumber(n: number): { year: number; month: number; day: number; weekday: number } {
  const d = new Date(n * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The wall-clock time of the instant `ms` in `timezone`.
 * weekday: 0 = Sunday … 6 = Saturday. Throws bad_request for unknown zones.
 */
/** Largest |epoch ms| a Date can represent. */
const MAX_TIME = 8.64e15;

export function utcToZoned(ms: number, timezone: string): ZonedParts {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_TIME) throw bad(`Invalid time value: ${ms}`);
  const parts = formatterFor(timezone).formatToParts(new Date(ms));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let bc = false;
  for (const p of parts) {
    switch (p.type) {
      case 'year':
        year = Number(p.value);
        break;
      case 'month':
        month = Number(p.value);
        break;
      case 'day':
        day = Number(p.value);
        break;
      case 'hour':
        hour = Number(p.value) % 24;
        break;
      case 'minute':
        minute = Number(p.value);
        break;
      case 'second':
        second = Number(p.value);
        break;
      case 'era':
        bc = p.value.startsWith('B');
        break;
    }
  }
  if (bc) year = 1 - year;
  const weekday = fromDayNumber(dayNumber(year, month, day)).weekday;
  return { year, month, day, hour, minute, second, weekday };
}

type WallTime = { year: number; month: number; day: number; hour: number; minute: number; second?: number };

function naiveUtc(p: WallTime): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second ?? 0);
}

/** Local-minus-UTC offset (ms) in effect at the instant `ms`. */
function offsetAt(ms: number, timezone: string): number {
  const p = utcToZoned(ms, timezone);
  return naiveUtc(p) - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The instant at which the wall clock in `timezone` shows `parts`
 * (fields may overflow, e.g. day 32 → next month).
 *
 * - DST gap (the time doesn't exist): moves forward by the gap, i.e. uses the
 *   offset in effect before the transition ("02:30" on a spring-forward day → "03:30").
 * - Overlap (the time happens twice): returns the earlier instant.
 *
 * The offsets one day before and after the naive guess bracket any transition
 * that can affect this wall time, so both candidates are checked explicitly;
 * this works for zones on either side of UTC and for odd-sized transitions.
 */
export function zonedTimeToUtc(parts: Omit<ZonedParts, 'weekday' | 'second'> & { second?: number }, timezone: string): number {
  const wall = naiveUtc(parts);
  if (!Number.isFinite(wall)) throw bad('Invalid date/time fields.');
  const before = offsetAt(wall - DAY_MS, timezone);
  const after = offsetAt(wall + DAY_MS, timezone);
  const candidates = before === after ? [wall - before] : [wall - before, wall - after];
  const valid = candidates.filter((t) => offsetAt(t, timezone) === wall - t);
  if (valid.length > 0) return Math.min(...valid);
  // Neither offset reproduces the wall time: it falls in a gap.
  return wall - before;
}

/** "2026-10-10T20:15:00" in `timezone` (no offset suffix). */
export function formatLocalIso(ms: number, timezone: string): string {
  const p = utcToZoned(ms, timezone);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

// ───────────────────────────── parseDateTime ─────────────────────────────

const ACCEPTED_FORMS =
  'Use epoch ms, ISO 8601 ("2026-10-12T09:00:00+08:00", or without offset for local time), ' +
  '"now", "in 10 minutes", "in 2 hours", "in 3 days", "today 18:30", "tonight", "tomorrow 9:00", ' +
  '"tomorrow at 9am", "friday 14:00", "next monday at 8am" or a bare time like "18:30".';

const WEEKDAY_WORDS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const NAMED_TIMES: Record<string, [number, number]> = {
  morning: [9, 0],
  noon: [12, 0],
  midday: [12, 0],
  afternoon: [15, 0],
  evening: [19, 0],
  night: [21, 0],
};

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

function unitOf(word: string): 's' | 'm' | 'h' | 'd' | 'w' | null {
  if (/^(s|secs?|seconds?)$/.test(word)) return 's';
  if (/^(m|mins?|minutes?)$/.test(word)) return 'm';
  if (/^(h|hrs?|hours?)$/.test(word)) return 'h';
  if (/^(d|days?)$/.test(word)) return 'd';
  if (/^(w|wks?|weeks?)$/.test(word)) return 'w';
  return null;
}

/**
 * Parse a time of day: "9", "9:30", "09:30:15", "9am", "9:30 pm", "noon", "midnight", "morning"…
 * Returns null when `s` is not a time of day; throws for out-of-range values.
 */
function parseTimeOfDay(s: string, opts: { evening?: boolean } = {}): [number, number, number] | null {
  const named = NAMED_TIMES[s];
  if (named) return [named[0], named[1], 0];
  if (s === 'midnight') return [0, 0, 0];
  const m = /^(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const second = m[3] === undefined ? 0 : Number(m[3]);
  const meridiem = m[4]?.charAt(0);
  if (minute > 59 || second > 59) throw bad(`Invalid time "${s}".`);
  if (meridiem) {
    if (hour < 1 || hour > 12) throw bad(`Invalid time "${s}": use 1-12 with am/pm.`);
    if (meridiem === 'p' && hour < 12) hour += 12;
    if (meridiem === 'a' && hour === 12) hour = 0;
  } else {
    if (hour > 23) throw bad(`Invalid time "${s}".`);
    // "tonight at 9" means 21:00.
    if (opts.evening && hour >= 1 && hour < 12) hour += 12;
  }
  return [hour, minute, second];
}

/** Require a time of day (after "today"/"tomorrow"/a weekday) or the default when absent. */
function timePart(rest: string, fallback: [number, number, number], what: string, opts: { evening?: boolean } = {}): [number, number, number] {
  const r = rest.replace(/^(at|@)\s*/, '').trim();
  if (!r) return fallback;
  const t = parseTimeOfDay(r, opts);
  if (!t) throw bad(`Cannot understand the time "${rest.trim()}" in "${what}". ${ACCEPTED_FORMS}`);
  return t;
}

function validateCalendar(year: number, month: number, day: number, hour: number, minute: number, second: number, input: string) {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    throw bad(`"${input}" is not a valid date/time.`);
  }
}

/**
 * Parse `input` into epoch ms. Relative and wall-clock forms are interpreted in
 * `timezone` relative to `nowMs`. Throws NeoError('bad_request') with the list
 * of accepted forms when the input can't be understood.
 */
export function parseDateTime(input: string | number, nowMs: number, timezone: string): number {
  const result = parse(input, nowMs, timezone);
  if (!Number.isFinite(result) || Math.abs(result) > MAX_TIME) throw bad(`The date/time "${String(input)}" is out of range.`);
  return result;
}

function parse(input: string | number, nowMs: number, timezone: string): number {
  assertTimeZone(timezone);
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw bad(`Invalid time value: ${input}.`);
    return Math.round(input);
  }
  if (typeof input !== 'string') throw bad(`Invalid date/time: ${String(input)}. ${ACCEPTED_FORMS}`);
  const raw = input.trim();
  if (!raw) throw bad(`Empty date/time. ${ACCEPTED_FORMS}`);
  const s = raw.toLowerCase().replace(/\s+/g, ' ');

  // Epoch ms (13 digits) or epoch seconds (10 digits).
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;

  // ISO 8601 date with optional time and optional offset.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(z|[+-]\d{2}(?::?\d{2})?)?$/.exec(s);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const hour = iso[4] === undefined ? 0 : Number(iso[4]);
    const minute = iso[5] === undefined ? 0 : Number(iso[5]);
    const second = iso[6] === undefined ? 0 : Number(iso[6]);
    const ms = iso[7] === undefined ? 0 : Math.round(Number(`0.${iso[7]}`) * 1000);
    validateCalendar(year, month, day, hour, minute, second, raw);
    const zone = iso[8];
    if (zone !== undefined) {
      if (iso[4] === undefined) throw bad(`"${raw}": an offset needs a time of day.`);
      let offsetMin = 0;
      if (zone !== 'z') {
        const sign = zone.startsWith('-') ? -1 : 1;
        const digits = zone.slice(1).replace(':', '');
        const oh = Number(digits.slice(0, 2));
        const om = digits.length > 2 ? Number(digits.slice(2)) : 0;
        if (oh > 14 || om > 59) throw bad(`"${raw}" has an invalid UTC offset.`);
        offsetMin = sign * (oh * 60 + om);
      }
      return Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMin * 60_000;
    }
    return zonedTimeToUtc({ year, month, day, hour, minute, second }, timezone) + ms;
  }

  if (s === 'now' || s === 'right now') return nowMs;

  const now = utcToZoned(nowMs, timezone);
  const at = (dayOffset: number, t: [number, number, number]) =>
    zonedTimeToUtc({ year: now.year, month: now.month, day: now.day + dayOffset, hour: t[0], minute: t[1], second: t[2] }, timezone);

  // Relative: "in 10 minutes", "in an hour", "in 1.5 hours", "in 3 days", "in 2 weeks".
  const rel = /^in (\d+(?:\.\d+)?|an?|one) ?([a-z]+)$/.exec(s);
  if (rel) {
    const n = /^\d/.test(rel[1] as string) ? Number(rel[1]) : 1;
    const unit = unitOf(rel[2] as string);
    if (!unit) throw bad(`Unknown time unit "${rel[2]}" in "${raw}". ${ACCEPTED_FORMS}`);
    if (unit === 'd' || unit === 'w') {
      // Calendar days in the user's zone: "in 3 days" keeps the wall-clock time across DST.
      const days = n * (unit === 'w' ? 7 : 1);
      if (!Number.isInteger(days)) return nowMs + Math.round(days * DAY_MS);
      return at(days, [now.hour, now.minute, now.second]) + (nowMs % 1000);
    }
    return nowMs + Math.round(n * (UNIT_MS[unit] as number));
  }

  // today / tonight / tomorrow [at] [time]
  const day = /^(today|tonight|tomorrow|tmrw|tmr)\b ?(.*)$/.exec(s);
  if (day) {
    const word = day[1] as string;
    const rest = day[2] as string;
    if (word === 'today') return at(0, timePart(rest, [now.hour, now.minute, now.second], raw));
    if (word === 'tonight') return at(0, timePart(rest, [20, 0, 0], raw, { evening: true }));
    return at(1, timePart(rest, [9, 0, 0], raw));
  }

  // Weekday: "friday", "next fri 14:00", "on tuesday at 6pm", "this monday".
  const wd = /^(?:(?:on|next|this) )?([a-z]+)\b ?(.*)$/.exec(s);
  if (wd && WEEKDAY_WORDS[wd[1] as string] !== undefined) {
    const target = WEEKDAY_WORDS[wd[1] as string] as number;
    let ahead = (target - now.weekday + 7) % 7;
    if (ahead === 0) ahead = 7;
    return at(ahead, timePart(wd[2] as string, [9, 0, 0], raw));
  }

  // A bare time of day: today, or tomorrow when it has already passed.
  const bare = parseTimeOfDay(s.replace(/^(at|@) ?/, ''));
  if (bare) {
    const today = at(0, bare);
    return today > nowMs ? today : at(1, bare);
  }

  throw bad(`Cannot parse the date/time "${raw}". ${ACCEPTED_FORMS}`);
}
