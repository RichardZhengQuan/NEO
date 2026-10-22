/**
 * Locale-aware formatting helpers shared by the UI kit and the apps.
 * All functions are pure and never throw (bad input falls back to ISO text).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function safeTz(timeZone: string | undefined): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(0);
    return timeZone;
  } catch {
    return undefined;
  }
}

/** "Oct 10, 2026, 5:00 PM" (medium date + short time). */
export function formatDateTime(ms: number, locale?: string, timeZone?: string): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return '—';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: safeTz(timeZone) }).format(ms);
  } catch {
    return new Date(ms).toISOString();
  }
}

/** "Oct 10, 2026". */
export function formatDate(ms: number, locale?: string, timeZone?: string, style: 'short' | 'medium' | 'long' | 'full' = 'medium'): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return '—';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone: safeTz(timeZone) }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** "5:00 PM". */
export function formatTime(ms: number, locale?: string, timeZone?: string): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return '—';
  try {
    return new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: safeTz(timeZone) }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/** "in 5 minutes", "2 hours ago", "yesterday" — relative to `now`. */
export function formatRelative(ms: number, locale?: string, now: number = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (abs < 45_000) return rtf.format(0, 'second');
    if (abs < HOUR) return rtf.format(Math.round(diff / MINUTE), 'minute');
    if (abs < DAY) return rtf.format(Math.round(diff / HOUR), 'hour');
    if (abs < 7 * DAY) return rtf.format(Math.round(diff / DAY), 'day');
    if (abs < 30 * DAY) return rtf.format(Math.round(diff / (7 * DAY)), 'week');
    if (abs < 365 * DAY) return rtf.format(Math.round(diff / (30 * DAY)), 'month');
    return rtf.format(Math.round(diff / (365 * DAY)), 'year');
  } catch {
    return formatDateTime(ms, locale);
  }
}

/** Compact number: 1.2k, 3.4M. */
export function formatCompact(n: number, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}

export function formatNumber(n: number, locale?: string, options?: Intl.NumberFormatOptions): string {
  try {
    return new Intl.NumberFormat(locale, options).format(n);
  } catch {
    return String(n);
  }
}

/** Calendar day key (YYYY-MM-DD) of an instant in a timezone. */
export function dayKey(ms: number, timeZone?: string): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return '0000-00-00';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: safeTz(timeZone) }).formatToParts(ms);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}
