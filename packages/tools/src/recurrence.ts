/**
 * nextOccurrence: the next firing time of a recurrence rule.
 *
 * Wall-clock math happens in the reminder's IANA zone: the anchor (first
 * dueAt) fixes the local time of day, and each occurrence is that time on a
 * local calendar date, so "every day at 09:00" stays at 09:00 across DST.
 *
 * - hourly:  anchor + k·interval hours (absolute time, unaffected by DST).
 * - daily:   every `interval` days; `byWeekday` (optional) keeps only those weekdays.
 * - weekly:  weeks start on Monday (RFC 5545 default); every `interval` weeks
 *            starting with the anchor's week, on each `byWeekday` day (default: the
 *            anchor's weekday). Days before the anchor in its own week are skipped.
 * - monthly: every `interval` months on each `byMonthDay` (default: the anchor's
 *            day; -1 = last day). Days a month doesn't have (e.g. the 31st) are skipped.
 * - yearly:  every `interval` years on the anchor's month/day (Feb 29 → leap years only).
 *
 * The anchor itself is always the first occurrence. Each computation jumps
 * directly to the period containing `after`, so a reminder that has been
 * idle for years costs the same as one that fired yesterday.
 */
import type { Recurrence } from '@neo/protocol';
import { dayNumber, daysInMonth, fromDayNumber, utcToZoned, zonedTimeToUtc } from './time.js';

const HOUR_MS = 3_600_000;
/** Enough periods to cover a full 400-year Gregorian cycle of month lengths and leap days. */
const MAX_PERIODS = 4800;

/**
 * The first occurrence strictly after `afterMs`, or null when the rule is
 * exhausted: `occurrencesSoFar + 1 > count`, the next occurrence is past
 * `until`, or the rule can never match (e.g. the 30th of every February).
 *
 * @param rule              recurrence rule (interval defaults to 1)
 * @param anchorMs          the first dueAt; fixes the wall-clock time of day
 * @param afterMs           only occurrences strictly after this instant
 * @param timezone          IANA zone for the wall-clock math
 * @param occurrencesSoFar  how many times the reminder already fired (for `count`)
 */
export function nextOccurrence(rule: Recurrence, anchorMs: number, afterMs: number, timezone: string, occurrencesSoFar = 0): number | null {
  const { count, until } = rule;
  if (count !== undefined && occurrencesSoFar + 1 > count) return null;
  const next = afterMs < anchorMs ? anchorMs : candidateAfter(rule, anchorMs, afterMs, timezone);
  if (next === null) return null;
  if (until !== undefined && next > until) return null;
  return next;
}

function candidateAfter(rule: Recurrence, anchorMs: number, afterMs: number, timezone: string): number | null {
  const interval = Math.max(1, Math.floor(rule.interval ?? 1));

  if (rule.freq === 'hourly') {
    const step = interval * HOUR_MS;
    return anchorMs + (Math.floor((afterMs - anchorMs) / step) + 1) * step;
  }

  const anchor = utcToZoned(anchorMs, timezone);
  const after = utcToZoned(afterMs, timezone);
  const anchorDay = dayNumber(anchor.year, anchor.month, anchor.day);
  const afterDay = dayNumber(after.year, after.month, after.day);
  const at = (year: number, month: number, day: number) =>
    zonedTimeToUtc({ year, month, day, hour: anchor.hour, minute: anchor.minute, second: anchor.second }, timezone);
  const atDay = (n: number) => {
    const d = fromDayNumber(n);
    return at(d.year, d.month, d.day);
  };

  switch (rule.freq) {
    case 'daily': {
      const weekdays = rule.byWeekday?.length ? new Set(rule.byWeekday) : null;
      // Start one period before `after`'s local date so DST edge cases can't skip a day.
      let k = Math.max(0, Math.floor((afterDay - anchorDay) / interval) - 1);
      for (let i = 0; i < MAX_PERIODS; i++, k++) {
        const n = anchorDay + k * interval;
        if (weekdays && !weekdays.has(fromDayNumber(n).weekday)) continue;
        const t = atDay(n);
        if (t > afterMs) return t;
      }
      return null;
    }

    case 'weekly': {
      const mondayOffset = (wd: number) => (wd + 6) % 7;
      const offsets = [...new Set(rule.byWeekday?.length ? rule.byWeekday : [anchor.weekday])].map(mondayOffset).sort((a, b) => a - b);
      const weekStart0 = anchorDay - mondayOffset(anchor.weekday);
      const period = 7 * interval;
      let k = Math.max(0, Math.floor((afterDay - weekStart0) / period) - 1);
      for (let i = 0; i < MAX_PERIODS; i++, k++) {
        for (const off of offsets) {
          const n = weekStart0 + k * period + off;
          if (n < anchorDay) continue;
          const t = atDay(n);
          if (t > afterMs) return t;
        }
      }
      return null;
    }

    case 'monthly': {
      const days = rule.byMonthDay?.length ? rule.byMonthDay : [anchor.day];
      const monthIndex0 = anchor.year * 12 + (anchor.month - 1);
      const afterIndex = after.year * 12 + (after.month - 1);
      let k = Math.max(0, Math.floor((afterIndex - monthIndex0) / interval));
      for (let i = 0; i < MAX_PERIODS; i++, k++) {
        const idx = monthIndex0 + k * interval;
        const year = Math.floor(idx / 12);
        const month = (idx % 12) + 1;
        const dim = daysInMonth(year, month);
        const resolved = [...new Set(days.map((d) => (d === -1 ? dim : d)).filter((d) => d >= 1 && d <= dim))].sort((a, b) => a - b);
        for (const day of resolved) {
          if (k === 0 && day < anchor.day) continue;
          const t = at(year, month, day);
          if (t > afterMs) return t;
        }
      }
      return null;
    }

    case 'yearly': {
      let k = Math.max(0, Math.floor((after.year - anchor.year) / interval));
      for (let i = 0; i < MAX_PERIODS; i++, k++) {
        const year = anchor.year + k * interval;
        if (anchor.day > daysInMonth(year, anchor.month)) continue; // Feb 29 outside leap years
        const t = at(year, anchor.month, anchor.day);
        if (t > afterMs) return t;
      }
      return null;
    }

    default:
      return null;
  }
}
