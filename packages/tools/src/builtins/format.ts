/** Formatting helpers shared by the built-in tools. */
import { WEEKDAY_NAMES, formatLocalIso, utcToZoned } from '../time.js';

/** Cut `s` to at most `max` characters (with an ellipsis when cut). */
export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…` : s;
}

/** Local wall-clock ISO string ("2026-10-11T09:00:00") in `timezone`. */
export function localIso(ms: number, timezone: string): string {
  return formatLocalIso(ms, timezone);
}

export function weekdayName(ms: number, timezone: string): string {
  return WEEKDAY_NAMES[utcToZoned(ms, timezone).weekday] as string;
}

/** Human time for summaries and list subtitles: "Sun, Oct 11, 9:00 AM" (in the user's locale when known). */
export function friendlyTime(ms: number, timezone: string, locale = 'en-US'): string {
  const options: Intl.DateTimeFormatOptions = { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat(locale || 'en-US', options).format(ms);
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(ms);
  }
}
