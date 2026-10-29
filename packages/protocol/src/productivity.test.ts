import { describe, expect, it } from 'vitest';
import { describeRecurrence, RecurrenceSchema } from './productivity.js';

describe('describeRecurrence end dates', () => {
  it.each([
    [0, '1970-01-01'],
    [-1, '1969-12-31'],
    [86_400_000, '1970-01-02'],
    [Date.parse('2026-10-29T23:59:59.999Z'), '2026-10-29'],
    [Date.parse('0000-01-01T00:00:00.000Z'), '0000-01-01'],
    [Date.parse('-000001-12-31T23:59:59.999Z'), '-000001-12-31'],
    [Date.parse('9999-12-31T23:59:59.999Z'), '9999-12-31'],
    [Date.parse('+010000-01-01T00:00:00.000Z'), '+010000-01-01'],
    [-8.64e15, '-271821-04-20'],
    [8.64e15, '+275760-09-13'],
  ])('includes the end date at timestamp %s', (until, date) => {
    expect(describeRecurrence({ freq: 'daily', until })).toBe(`every day, until ${date}`);
  });

  it.each([
    [-8.64e15, '-271821-04-20'],
    [8.64e15, '+275760-09-13'],
  ])('formats schema-valid Date extrema with interval, weekdays and count (%s)', (until, date) => {
    const recurrence = RecurrenceSchema.parse({ freq: 'weekly', interval: 2, byWeekday: [3, 1], count: 4, until });
    expect(describeRecurrence(recurrence)).toBe(`every 2 weeks on Mon, Wed, 4 times, until ${date}`);
  });

  it('omits an absent end date', () => {
    expect(describeRecurrence({ freq: 'daily' })).toBe('every day');
    expect(describeRecurrence({ freq: 'daily', until: undefined })).toBe('every day');
  });

  it('preserves interval, sorted weekdays and count alongside an epoch end date', () => {
    expect(describeRecurrence({ freq: 'weekly', interval: 2, byWeekday: [3, 1], count: 4, until: 0 }))
      .toBe('every 2 weeks on Mon, Wed, 4 times, until 1970-01-01');
  });

  it('preserves monthly day and count formatting without an end date', () => {
    expect(describeRecurrence({ freq: 'monthly', byMonthDay: [-1, 15], count: 2 }))
      .toBe('every month on the last day, day 15, 2 times');
    expect(describeRecurrence(null)).toBe('once');
    expect(describeRecurrence(undefined)).toBe('once');
  });
});
