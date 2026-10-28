/**
 * Localized recurrence descriptions and the repeat presets the reminder editor
 * offers. (@neo/protocol's describeRecurrence is English-only.)
 */
import type { RecurrenceInput } from '@neo/protocol';
import type { TranslateFn } from '@neo/ui';
import { formatDate } from '@neo/ui';

/** Short weekday name for 0 = Sunday … 6 = Saturday. */
export function weekdayName(day: number, locale: string, style: 'short' | 'narrow' | 'long' = 'short'): string {
  try {
    return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(Date.UTC(2023, 0, 1 + day));
  } catch {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day] ?? String(day);
  }
}

function listFormat(items: string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: 'short', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

export function describeRecurrence(r: RecurrenceInput | null | undefined, t: TranslateFn, locale: string, timeZone?: string): string {
  if (!r) return t('recur.once');
  const n = r.interval ?? 1;
  let s: string;
  switch (r.freq) {
    case 'hourly':
      s = n === 1 ? t('recur.hourly') : t('recur.every_hours', { n });
      break;
    case 'daily': {
      const days = [...(r.byWeekday ?? [])].sort((a, b) => a - b);
      if (days.length) {
        const names = listFormat(days.map((d) => weekdayName(d, locale)), locale);
        s = n === 1 ? t('recur.daily_on', { days: names }) : t('recur.every_days_on', { n, days: names });
      } else {
        s = n === 1 ? t('recur.daily') : t('recur.every_days', { n });
      }
      break;
    }
    case 'weekly': {
      const days = [...(r.byWeekday ?? [])].sort((a, b) => a - b);
      const weekdays = days.length === 5 && days.every((d, i) => d === i + 1);
      if (weekdays && n === 1) s = t('recur.weekdays');
      else if (days.length) {
        const names = listFormat(days.map((d) => weekdayName(d, locale)), locale);
        s = n === 1 ? t('recur.weekly_on', { days: names }) : t('recur.every_weeks_on', { n, days: names });
      } else s = n === 1 ? t('recur.weekly') : t('recur.every_weeks', { n });
      break;
    }
    case 'monthly': {
      const days = r.byMonthDay ?? [];
      if (days.length) {
        const names = listFormat(
          days.map((d) => (d === -1 ? t('recur.last_day') : t('recur.day_n', { n: d }))),
          locale,
        );
        s = n === 1 ? t('recur.monthly_on', { days: names }) : t('recur.every_months_on', { n, days: names });
      } else s = n === 1 ? t('recur.monthly') : t('recur.every_months', { n });
      break;
    }
    case 'yearly':
      s = n === 1 ? t('recur.yearly') : t('recur.every_years', { n });
      break;
  }
  if (r.count) s += ` · ${t('recur.count', { n: r.count })}`;
  if (r.until != null) s += ` · ${t('recur.until', { date: formatDate(r.until, locale, timeZone) })}`;
  return s;
}

export type RepeatPreset = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';

/** Map a stored recurrence to the closest editor preset. */
export function presetOf(r: RecurrenceInput | null | undefined): RepeatPreset {
  if (!r) return 'none';
  if (r.freq === 'weekly') {
    const days = [...(r.byWeekday ?? [])].sort((a, b) => a - b);
    if (days.length === 5 && days.every((d, i) => d === i + 1)) return 'weekdays';
    return 'weekly';
  }
  if (r.freq === 'hourly') return 'daily';
  return r.freq;
}

/** Build the recurrence for a preset; `weekday` is the due date's weekday (for weekly). */
export function recurrenceFor(preset: RepeatPreset, opts: { interval?: number; weekdays?: number[]; weekday: number }): RecurrenceInput | null {
  const interval = Math.max(1, Math.min(1000, Math.round(opts.interval ?? 1)));
  switch (preset) {
    case 'none':
      return null;
    case 'daily':
      return { freq: 'daily', interval };
    case 'weekdays':
      return { freq: 'weekly', interval: 1, byWeekday: [1, 2, 3, 4, 5] };
    case 'weekly':
      return { freq: 'weekly', interval, byWeekday: opts.weekdays?.length ? [...opts.weekdays].sort((a, b) => a - b) : [opts.weekday] };
    case 'monthly':
      return { freq: 'monthly', interval };
    case 'yearly':
      return { freq: 'yearly', interval };
  }
}

/**
 * Overlay editable recurrence fields while preserving the original frequency,
 * end conditions, daily weekday filters, monthly days and the interval hidden
 * by the weekdays preset. Call only while the preset is unchanged.
 * Pass `generated = null` when the user set the preset to 'none'.
 */
export function preserveRecurrence(original: RecurrenceInput | null | undefined, generated: RecurrenceInput | null): RecurrenceInput | null {
  if (!generated) return null;
  if (!original) return generated;
  const r: RecurrenceInput = { ...generated };
  // Restore original freq when presetOf was lossy (e.g. hourly→daily).
  if (original.freq !== generated.freq) r.freq = original.freq;
  // Restore unexposed end conditions.
  if (original.count !== undefined) r.count = original.count;
  if (original.until !== undefined) r.until = original.until;
  // Restore filters and intervals the current preset cannot expose.
  if (original.byWeekday?.length && r.freq === 'daily') r.byWeekday = [...original.byWeekday];
  if (presetOf(original) === 'weekdays') r.interval = original.interval ?? 1;
  if (original.byMonthDay?.length && r.freq === 'monthly') r.byMonthDay = [...original.byMonthDay];
  return r;
}
