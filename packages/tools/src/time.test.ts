/** Review tests for utcToZoned / zonedTimeToUtc / parseDateTime. */
import { describe, expect, it } from 'vitest';
import { NeoError } from '@neo/protocol';
import { parseDateTime, utcToZoned, zonedTimeToUtc } from './time.js';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);

function expectBadRequest(fn: () => unknown, message?: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(NeoError);
    expect((err as NeoError).code).toBe('bad_request');
    if (message) expect((err as NeoError).message).toMatch(message);
    return;
  }
  throw new Error('expected a bad_request NeoError');
}

describe('zonedTimeToUtc across DST', () => {
  it('America/New_York spring-forward gap moves forward by the gap', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York')).toBe(utc(2026, 3, 8, 7, 30));
  });

  it('America/New_York fall-back overlap takes the earlier (EDT) instant', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York')).toBe(utc(2026, 11, 1, 5, 30));
  });

  it('Europe/Berlin spring-forward gap moves forward by the gap (positive offset zone)', () => {
    // 02:30 does not exist on 2026-03-29; 03:30 CEST = 01:30Z.
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Berlin')).toBe(utc(2026, 3, 29, 1, 30));
  });

  it('Europe/Berlin fall-back overlap takes the earlier (CEST) instant', () => {
    // 02:30 happens twice on 2026-10-25: 00:30Z (CEST) and 01:30Z (CET).
    expect(zonedTimeToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, 'Europe/Berlin')).toBe(utc(2026, 10, 25, 0, 30));
  });

  it('Australia/Lord_Howe 30-minute gap', () => {
    const t = zonedTimeToUtc({ year: 2026, month: 10, day: 4, hour: 2, minute: 15 }, 'Australia/Lord_Howe');
    const local = utcToZoned(t, 'Australia/Lord_Howe');
    expect([local.day, local.hour, local.minute]).toEqual([4, 2, 45]);
  });

  it('Asia/Shanghai has a fixed +08:00 offset', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 10, day: 10, hour: 20, minute: 15 }, 'Asia/Shanghai')).toBe(utc(2026, 10, 10, 12, 15));
    expect(zonedTimeToUtc({ year: 2026, month: 7, day: 1, hour: 0, minute: 0 }, 'Asia/Shanghai')).toBe(utc(2026, 6, 30, 16, 0));
  });

  it('round-trips every hour of a DST year in several zones', () => {
    for (const tz of ['America/New_York', 'Europe/Berlin', 'Asia/Shanghai', 'Australia/Sydney', 'UTC']) {
      for (let t = utc(2026, 1, 1); t < utc(2027, 1, 1); t += 3_600_000 * 7) {
        const p = utcToZoned(t, tz);
        const back = zonedTimeToUtc(p, tz);
        // Either the same instant, or (in an overlap) the earlier instant with the same wall time.
        expect(back <= t && t - back <= 3_600_000).toBe(true);
        const q = utcToZoned(back, tz);
        expect([q.year, q.month, q.day, q.hour, q.minute]).toEqual([p.year, p.month, p.day, p.hour, p.minute]);
      }
    }
  });
});

describe('utcToZoned', () => {
  it('weekday and midnight hour', () => {
    const p = utcToZoned(utc(2026, 10, 10, 16, 0), 'Asia/Shanghai'); // Sunday 00:00 local
    expect(p).toEqual({ year: 2026, month: 10, day: 11, hour: 0, minute: 0, second: 0, weekday: 0 });
  });

  it('rejects unknown timezones with bad_request', () => {
    expectBadRequest(() => utcToZoned(0, 'Mars/Olympus'), /timezone/i);
    expectBadRequest(() => zonedTimeToUtc({ year: 2026, month: 1, day: 1, hour: 0, minute: 0 }, 'Nope/Nope'), /timezone/i);
  });
});

describe('parseDateTime', () => {
  // Saturday 2026-10-10 12:15Z = 20:15 in Shanghai, 08:15 in New York.
  const NOW = utc(2026, 10, 10, 12, 15);
  const SH = 'Asia/Shanghai';
  const NY = 'America/New_York';

  it('epoch ms (number and string) and epoch seconds string', () => {
    expect(parseDateTime(1_791_594_000_000, NOW, SH)).toBe(1_791_594_000_000);
    expect(parseDateTime('1791594000000', NOW, SH)).toBe(1_791_594_000_000);
    expect(parseDateTime('1791594000', NOW, SH)).toBe(1_791_594_000_000);
  });

  it('ISO 8601 with offset', () => {
    expect(parseDateTime('2026-10-12T09:00:00+08:00', NOW, NY)).toBe(utc(2026, 10, 12, 1));
    expect(parseDateTime('2026-10-12T09:00:00+0800', NOW, NY)).toBe(utc(2026, 10, 12, 1));
    expect(parseDateTime('2026-10-12T09:00Z', NOW, NY)).toBe(utc(2026, 10, 12, 9));
    expect(parseDateTime('2026-10-12T09:00:00.500-04:00', NOW, SH)).toBe(utc(2026, 10, 12, 13) + 500);
  });

  it('ISO 8601 without offset is local time in the given zone', () => {
    expect(parseDateTime('2026-10-12T09:00:00', NOW, SH)).toBe(utc(2026, 10, 12, 1));
    expect(parseDateTime('2026-10-12T09:00:00.000', NOW, SH)).toBe(utc(2026, 10, 12, 1));
    expect(parseDateTime('2026-10-12 09:00', NOW, SH)).toBe(utc(2026, 10, 12, 1));
    expect(parseDateTime('2026-10-12', NOW, SH)).toBe(utc(2026, 10, 11, 16));
  });

  it('rejects impossible calendar dates and times instead of rolling them over', () => {
    expectBadRequest(() => parseDateTime('2026-02-30T10:00', NOW, SH));
    expectBadRequest(() => parseDateTime('2026-13-01', NOW, SH));
    expectBadRequest(() => parseDateTime('2026-10-12T25:00', NOW, SH));
    expectBadRequest(() => parseDateTime('2026-10-12T10:00:00+25:00', NOW, SH));
    expectBadRequest(() => parseDateTime('25:00', NOW, SH));
    expectBadRequest(() => parseDateTime('13pm', NOW, SH));
  });

  it('relative "in N units"', () => {
    expect(parseDateTime('in 10 minutes', NOW, SH)).toBe(NOW + 600_000);
    expect(parseDateTime('in 2 hours', NOW, SH)).toBe(NOW + 7_200_000);
    expect(parseDateTime('in an hour', NOW, SH)).toBe(NOW + 3_600_000);
    expect(parseDateTime('in 1.5 hours', NOW, SH)).toBe(NOW + 5_400_000);
    expect(parseDateTime('in 30 seconds', NOW, SH)).toBe(NOW + 30_000);
    expect(parseDateTime('in 3 days', NOW, SH)).toBe(NOW + 3 * 86_400_000);
    expect(parseDateTime('In 2 Weeks', NOW, SH)).toBe(NOW + 14 * 86_400_000);
  });

  it('"in N days" keeps the local wall-clock time across a DST change', () => {
    const fri9 = utc(2026, 10, 30, 13); // Fri 09:00 EDT
    expect(parseDateTime('in 3 days', fri9, NY)).toBe(utc(2026, 11, 2, 14)); // Mon 09:00 EST
  });

  it('tomorrow / today / tonight', () => {
    expect(parseDateTime('tomorrow', NOW, SH)).toBe(utc(2026, 10, 11, 1)); // 09:00 local
    expect(parseDateTime('tomorrow 9:00', NOW, SH)).toBe(utc(2026, 10, 11, 1));
    expect(parseDateTime('tomorrow at 9am', NOW, SH)).toBe(utc(2026, 10, 11, 1));
    expect(parseDateTime('Tomorrow at 7:30 PM', NOW, SH)).toBe(utc(2026, 10, 11, 11, 30));
    expect(parseDateTime('tomorrow noon', NOW, SH)).toBe(utc(2026, 10, 11, 4));
    expect(parseDateTime('today 22:30', NOW, SH)).toBe(utc(2026, 10, 10, 14, 30));
    expect(parseDateTime('tonight', NOW, NY)).toBe(utc(2026, 10, 11, 0)); // 20:00 EDT
    expect(parseDateTime('tonight at 9', NOW, NY)).toBe(utc(2026, 10, 11, 1)); // 21:00 EDT
  });

  it('weekday names (full, short, "next", "on") are strictly after today', () => {
    // NOW is Saturday in both zones.
    expect(parseDateTime('monday', NOW, SH)).toBe(utc(2026, 10, 12, 1)); // Mon 09:00 local
    expect(parseDateTime('next friday 14:00', NOW, SH)).toBe(utc(2026, 10, 16, 6));
    expect(parseDateTime('fri 9am', NOW, SH)).toBe(utc(2026, 10, 16, 1));
    expect(parseDateTime('on Tuesday at 18:00', NOW, SH)).toBe(utc(2026, 10, 13, 10));
    expect(parseDateTime('saturday', NOW, SH)).toBe(utc(2026, 10, 17, 1)); // a week ahead, not today
  });

  it('"this" weekday can be today only while its time is still ahead', () => {
    // Wednesday 2026-10-14 01:00Z = 09:00 in Singapore.
    const WED_SGT = utc(2026, 10, 14, 1);
    const SG = 'Asia/Singapore';
    expect(parseDateTime('this wednesday at 18:00', WED_SGT, SG)).toBe(utc(2026, 10, 14, 10));
    expect(parseDateTime('this wednesday at 06:00', WED_SGT, SG)).toBe(utc(2026, 10, 20, 22));
    expect(parseDateTime('this wednesday at 09:00', WED_SGT, SG)).toBe(utc(2026, 10, 21, 1));
    expect(parseDateTime('next wednesday at 18:00', WED_SGT, SG)).toBe(utc(2026, 10, 21, 10));
    expect(parseDateTime('on wednesday at 18:00', WED_SGT, SG)).toBe(utc(2026, 10, 21, 10));
    expect(parseDateTime('wednesday at 18:00', WED_SGT, SG)).toBe(utc(2026, 10, 21, 10));
  });

  it('bare times roll to tomorrow once passed', () => {
    expect(parseDateTime('21:00', NOW, SH)).toBe(utc(2026, 10, 10, 13));
    expect(parseDateTime('at 7pm', NOW, SH)).toBe(utc(2026, 10, 11, 11)); // 19:00 already passed today
    expect(parseDateTime('8:30am', NOW, SH)).toBe(utc(2026, 10, 11, 0, 30));
  });

  it('"now"', () => {
    expect(parseDateTime('now', NOW, SH)).toBe(NOW);
  });

  it('unparseable time parts are errors, not a silent 09:00', () => {
    expectBadRequest(() => parseDateTime('tomorrow blah', NOW, SH));
    expectBadRequest(() => parseDateTime('tomorrowish', NOW, SH));
    expectBadRequest(() => parseDateTime('friday at teatime', NOW, SH));
    expectBadRequest(() => parseDateTime('tonight 99', NOW, SH));
  });

  it('clear bad_request errors for garbage, empty input, bad numbers and bad zones', () => {
    expectBadRequest(() => parseDateTime('whenever', NOW, SH), /in 10 minutes/);
    expectBadRequest(() => parseDateTime('   ', NOW, SH));
    expectBadRequest(() => parseDateTime(Number.NaN, NOW, SH));
    expectBadRequest(() => parseDateTime('123456', NOW, SH));
    expectBadRequest(() => parseDateTime('tomorrow', NOW, 'Invalid/Zone'), /timezone/i);
    expectBadRequest(() => parseDateTime('in 999999999999999 minutes', NOW, SH), /range/i);
    expectBadRequest(() => parseDateTime(1e20, NOW, SH), /range/i);
    expectBadRequest(() => utcToZoned(1e20, SH));
  });
});
