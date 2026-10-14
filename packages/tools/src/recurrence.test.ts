/** Review tests for nextOccurrence. */
import { describe, expect, it, vi } from 'vitest';
import { RecurrenceSchema, type RecurrenceInput } from '@neo/protocol';
import { nextOccurrence } from './recurrence.js';
import { utcToZoned, zonedTimeToUtc } from './time.js';

// Spy on the wall-clock conversion (it still runs for real): every candidate occurrence costs one call.
vi.mock('./time.js', async (original) => {
  const actual = await original<typeof import('./time.js')>();
  return { ...actual, zonedTimeToUtc: vi.fn(actual.zonedTimeToUtc) };
});

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const rule = (r: RecurrenceInput) => RecurrenceSchema.parse(r);

/** Collect the first `n` occurrences after the anchor (the anchor itself is occurrence #1). */
function series(r: RecurrenceInput, anchor: number, tz: string, n: number): number[] {
  const out = [anchor];
  let after = anchor;
  while (out.length < n) {
    const next = nextOccurrence(rule(r), anchor, after, tz, 0);
    if (next === null) break;
    out.push(next);
    after = next;
  }
  return out;
}

const local = (t: number, tz: string) => {
  const p = utcToZoned(t, tz);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
};

describe('nextOccurrence: daily', () => {
  it('keeps 09:00 local across New York spring-forward and fall-back', () => {
    const tz = 'America/New_York';
    const spring = series({ freq: 'daily' }, utc(2026, 3, 6, 14), tz, 4).map((t) => local(t, tz));
    expect(spring).toEqual(['2026-03-06 09:00', '2026-03-07 09:00', '2026-03-08 09:00', '2026-03-09 09:00']);
    const fall = series({ freq: 'daily' }, utc(2026, 10, 30, 13), tz, 4).map((t) => local(t, tz));
    expect(fall).toEqual(['2026-10-30 09:00', '2026-10-31 09:00', '2026-11-01 09:00', '2026-11-02 09:00']);
  });

  it('keeps 09:00 local across Berlin DST', () => {
    const tz = 'Europe/Berlin';
    const s = series({ freq: 'daily' }, zonedTimeToUtc({ year: 2026, month: 3, day: 28, hour: 9, minute: 0 }, tz), tz, 3);
    expect(s.map((t) => local(t, tz))).toEqual(['2026-03-28 09:00', '2026-03-29 09:00', '2026-03-30 09:00']);
    expect(s[1]! - s[0]!).toBe(23 * 3_600_000);
  });

  it('a time inside the DST gap moves forward that day only', () => {
    const tz = 'America/New_York';
    const s = series({ freq: 'daily' }, zonedTimeToUtc({ year: 2026, month: 3, day: 7, hour: 2, minute: 30 }, tz), tz, 3);
    expect(s.map((t) => local(t, tz))).toEqual(['2026-03-07 02:30', '2026-03-08 03:30', '2026-03-09 02:30']);
  });

  it('interval and weekday filter ("every weekday")', () => {
    const tz = 'UTC';
    expect(series({ freq: 'daily', interval: 2 }, utc(2026, 10, 12, 9), tz, 3)).toEqual([utc(2026, 10, 12, 9), utc(2026, 10, 14, 9), utc(2026, 10, 16, 9)]);
    // Fri 2026-10-09 → Mon 2026-10-12 (weekend skipped)
    expect(nextOccurrence(rule({ freq: 'daily', byWeekday: [1, 2, 3, 4, 5] }), utc(2026, 10, 9, 9), utc(2026, 10, 9, 9), tz)).toBe(utc(2026, 10, 12, 9));
  });

  it('collapses a long downtime in one step: ten idle years cost what one idle day does', () => {
    const tz = 'Asia/Shanghai';
    const now = utc(2026, 10, 10, 12, 15);
    const anchorAt = (year: number, month: number, day: number) => zonedTimeToUtc({ year, month, day, hour: 9, minute: 0 }, tz);
    // Count the candidates nextOccurrence checks (one wall-clock conversion each) instead of timing it.
    const candidates = (anchor: number) => {
      vi.mocked(zonedTimeToUtc).mockClear();
      expect(nextOccurrence(rule({ freq: 'daily' }), anchor, now, tz)).toBe(utc(2026, 10, 11, 1));
      return vi.mocked(zonedTimeToUtc).mock.calls.length;
    };
    const afterOneDay = candidates(anchorAt(2026, 10, 9));
    expect(afterOneDay).toBeLessThanOrEqual(3);
    expect(candidates(anchorAt(2025, 10, 10))).toBe(afterOneDay);
    expect(candidates(anchorAt(2016, 1, 1))).toBe(afterOneDay);
  });
});

describe('nextOccurrence: weekly', () => {
  it('byWeekday within a week, in chronological order', () => {
    // Wed 2026-10-14 09:00 UTC, Mon/Wed/Fri
    const s = series({ freq: 'weekly', byWeekday: [5, 1, 3] }, utc(2026, 10, 14, 9), 'UTC', 5);
    expect(s).toEqual([utc(2026, 10, 14, 9), utc(2026, 10, 16, 9), utc(2026, 10, 19, 9), utc(2026, 10, 21, 9), utc(2026, 10, 23, 9)]);
  });

  it('interval 2 keeps every byWeekday day in the same (Monday-based) on-week', () => {
    const s = series({ freq: 'weekly', interval: 2, byWeekday: [1, 3] }, utc(2026, 10, 14, 9), 'UTC', 5);
    // Wed 14 (anchor) → Mon 26, Wed 28 → Mon Nov 9, Wed Nov 11
    expect(s).toEqual([utc(2026, 10, 14, 9), utc(2026, 10, 26, 9), utc(2026, 10, 28, 9), utc(2026, 11, 9, 9), utc(2026, 11, 11, 9)]);
  });

  it('interval 2 on a weekend pair stays on the same weekend', () => {
    const s = series({ freq: 'weekly', interval: 2, byWeekday: [6, 0] }, utc(2026, 10, 10, 10), 'UTC', 4);
    expect(s).toEqual([utc(2026, 10, 10, 10), utc(2026, 10, 11, 10), utc(2026, 10, 24, 10), utc(2026, 10, 25, 10)]);
  });

  it('defaults to the anchor weekday and keeps local time across DST', () => {
    const tz = 'America/New_York';
    const s = series({ freq: 'weekly' }, utc(2026, 10, 26, 13), tz, 3).map((t) => local(t, tz));
    expect(s).toEqual(['2026-10-26 09:00', '2026-11-02 09:00', '2026-11-09 09:00']);
  });

  it('jumps straight to the right week after a long downtime', () => {
    const anchor = utc(2020, 1, 6, 9); // a Monday
    expect(nextOccurrence(rule({ freq: 'weekly', interval: 3 }), anchor, utc(2026, 10, 10), 'UTC')).toBe(utc(2026, 10, 19, 9));
  });
});

describe('nextOccurrence: monthly', () => {
  it('byMonthDay 31 skips months without a 31st', () => {
    const s = series({ freq: 'monthly', byMonthDay: [31] }, utc(2026, 1, 31, 9), 'UTC', 5);
    expect(s).toEqual([utc(2026, 1, 31, 9), utc(2026, 3, 31, 9), utc(2026, 5, 31, 9), utc(2026, 7, 31, 9), utc(2026, 8, 31, 9)]);
  });

  it('defaults to the anchor day (also skipping short months)', () => {
    const s = series({ freq: 'monthly' }, utc(2026, 1, 30, 9), 'UTC', 3);
    expect(s).toEqual([utc(2026, 1, 30, 9), utc(2026, 3, 30, 9), utc(2026, 4, 30, 9)]);
  });

  it('-1 is the last day of every month (leap years included)', () => {
    const s = series({ freq: 'monthly', byMonthDay: [-1] }, utc(2028, 1, 31, 9), 'UTC', 4);
    expect(s).toEqual([utc(2028, 1, 31, 9), utc(2028, 2, 29, 9), utc(2028, 3, 31, 9), utc(2028, 4, 30, 9)]);
  });

  it('multiple days come out in chronological order', () => {
    const s = series({ freq: 'monthly', byMonthDay: [-1, 15] }, utc(2026, 1, 10, 9), 'UTC', 4);
    expect(s).toEqual([utc(2026, 1, 10, 9), utc(2026, 1, 15, 9), utc(2026, 1, 31, 9), utc(2026, 2, 15, 9)]);
  });

  it('never returns days before the anchor in the anchor month', () => {
    expect(nextOccurrence(rule({ freq: 'monthly', byMonthDay: [5, 20] }), utc(2026, 1, 10, 9), utc(2026, 1, 1), 'UTC')).toBe(utc(2026, 1, 10, 9));
    expect(nextOccurrence(rule({ freq: 'monthly', byMonthDay: [5, 20] }), utc(2026, 1, 10, 9), utc(2026, 1, 10, 9), 'UTC')).toBe(utc(2026, 1, 20, 9));
  });

  it('interval 3', () => {
    const s = series({ freq: 'monthly', interval: 3 }, utc(2026, 11, 15, 9), 'UTC', 3);
    expect(s).toEqual([utc(2026, 11, 15, 9), utc(2027, 2, 15, 9), utc(2027, 5, 15, 9)]);
  });

  it('a rule that can never match returns null instead of looping', () => {
    // Every 12 months on the 30th, anchored in February: February never has a 30th.
    expect(nextOccurrence(rule({ freq: 'monthly', interval: 12, byMonthDay: [30] }), utc(2026, 2, 10, 9), utc(2026, 2, 10, 9), 'UTC')).toBeNull();
  });
});

describe('nextOccurrence: yearly and hourly', () => {
  it('Feb 29 only fires in leap years (no drift to Feb 28)', () => {
    const s = series({ freq: 'yearly' }, utc(2028, 2, 29, 9), 'UTC', 3);
    expect(s).toEqual([utc(2028, 2, 29, 9), utc(2032, 2, 29, 9), utc(2036, 2, 29, 9)]);
  });

  it('ordinary yearly with interval', () => {
    expect(series({ freq: 'yearly', interval: 2 }, utc(2026, 7, 4, 9), 'UTC', 3)).toEqual([utc(2026, 7, 4, 9), utc(2028, 7, 4, 9), utc(2030, 7, 4, 9)]);
  });

  it('hourly uses absolute hours (DST does not shift it)', () => {
    const anchor = utc(2026, 3, 8, 5, 30);
    expect(nextOccurrence(rule({ freq: 'hourly', interval: 3 }), anchor, utc(2026, 3, 8, 9, 0), 'America/New_York')).toBe(utc(2026, 3, 8, 11, 30));
    expect(nextOccurrence(rule({ freq: 'hourly' }), utc(2016, 1, 1), utc(2026, 10, 10, 12, 15), 'UTC')).toBe(utc(2026, 10, 10, 13));
  });
});

describe('nextOccurrence: bounds and semantics', () => {
  it('is strictly after `after`', () => {
    const anchor = utc(2026, 10, 10, 9);
    expect(nextOccurrence(rule({ freq: 'daily' }), anchor, utc(2026, 10, 11, 9), 'UTC')).toBe(utc(2026, 10, 12, 9));
    expect(nextOccurrence(rule({ freq: 'daily' }), anchor, utc(2026, 10, 11, 9) - 1, 'UTC')).toBe(utc(2026, 10, 11, 9));
  });

  it('returns the anchor when `after` is before it', () => {
    const anchor = utc(2026, 10, 14, 9); // Wednesday
    expect(nextOccurrence(rule({ freq: 'weekly', byWeekday: [1] }), anchor, utc(2026, 10, 1), 'UTC')).toBe(anchor);
  });

  it('count: null once fired + 1 > count', () => {
    const anchor = utc(2026, 10, 10, 9);
    const r = rule({ freq: 'daily', count: 3 });
    expect(nextOccurrence(r, anchor, anchor, 'UTC', 2)).toBe(utc(2026, 10, 11, 9));
    expect(nextOccurrence(r, anchor, anchor, 'UTC', 3)).toBeNull();
  });

  it('until: inclusive bound', () => {
    const anchor = utc(2026, 10, 10, 9);
    const r = rule({ freq: 'daily', until: utc(2026, 10, 12, 9) });
    expect(nextOccurrence(r, anchor, utc(2026, 10, 11, 9), 'UTC')).toBe(utc(2026, 10, 12, 9));
    expect(nextOccurrence(r, anchor, utc(2026, 10, 12, 9), 'UTC')).toBeNull();
  });

  it('Asia/Shanghai monthly at 08:00 local', () => {
    const tz = 'Asia/Shanghai';
    const s = series({ freq: 'monthly' }, zonedTimeToUtc({ year: 2026, month: 1, day: 1, hour: 8, minute: 0 }, tz), tz, 3);
    expect(s.map((t) => local(t, tz))).toEqual(['2026-01-01 08:00', '2026-02-01 08:00', '2026-03-01 08:00']);
  });
});
