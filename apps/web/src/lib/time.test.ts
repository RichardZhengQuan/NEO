import { describe, expect, it } from 'vitest';
import { fromLocalInputValue, instantOf, nextTimeOfDay, toLocalInputValue, tomorrowAt, wallTimeOf } from './time.js';

describe('timezone conversions', () => {
  it('round-trips wall time in a fixed-offset zone', () => {
    const ms = fromLocalInputValue('2026-10-10T17:30', 'Asia/Shanghai');
    expect(ms).toBe(Date.UTC(2026, 9, 10, 9, 30));
    expect(toLocalInputValue(ms!, 'Asia/Shanghai')).toBe('2026-10-10T17:30');
  });

  it('handles DST in New York (EDT vs EST)', () => {
    expect(instantOf(2026, 7, 1, 9, 0, 'America/New_York')).toBe(Date.UTC(2026, 6, 1, 13, 0));
    expect(instantOf(2026, 12, 1, 9, 0, 'America/New_York')).toBe(Date.UTC(2026, 11, 1, 14, 0));
  });

  it('resolves a nonexistent spring-forward time to a real instant', () => {
    const ms = instantOf(2026, 3, 8, 2, 30, 'America/New_York');
    const w = wallTimeOf(ms, 'America/New_York');
    expect(w.hour === 3 || w.hour === 1).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(fromLocalInputValue('tomorrow', 'UTC')).toBeNull();
    expect(fromLocalInputValue('2026-13-01T10:00', 'UTC')).toBeNull();
  });

  it('finds the next time of day', () => {
    const now = Date.UTC(2026, 9, 10, 12, 0); // 20:00 in Shanghai
    expect(nextTimeOfDay(9, 0, now, 'Asia/Shanghai')).toBe(Date.UTC(2026, 9, 11, 1, 0));
    expect(nextTimeOfDay(21, 0, now, 'Asia/Shanghai')).toBe(Date.UTC(2026, 9, 10, 13, 0));
  });

  it('tomorrowAt is always the next calendar day', () => {
    const early = Date.UTC(2026, 9, 10, 22, 0); // 06:00 on Oct 11 in Shanghai
    expect(tomorrowAt(9, 0, early, 'Asia/Shanghai')).toBe(Date.UTC(2026, 9, 12, 1, 0));
  });

  it('reports weekdays', () => {
    expect(wallTimeOf(Date.UTC(2026, 9, 10, 12, 0), 'UTC').weekday).toBe(6);
  });
});
