import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMessages, createTranslator } from '@neo/ui';
import { appDictionaries } from '../i18n.js';
import { describeRecurrence } from './recurrence.js';

const t = createTranslator('en', buildMessages('en', appDictionaries));

describe('describeRecurrence', () => {
  it('includes weekdays in daily recurrences', () => {
    expect(describeRecurrence({ freq: 'daily', byWeekday: [1, 3, 5] }, t, 'en')).toBe('Every day on Mon, Wed, & Fri');
  });

  it('includes weekdays in daily recurrences with an interval', () => {
    expect(describeRecurrence({ freq: 'daily', interval: 2, byWeekday: [1, 5] }, t, 'en')).toBe('Every 2 days on Mon & Fri');
  });

  it('keeps daily recurrences without weekdays unchanged', () => {
    expect(describeRecurrence({ freq: 'daily' }, t, 'en')).toBe('Every day');
  });

  it('keeps daily intervals without weekdays unchanged', () => {
    expect(describeRecurrence({ freq: 'daily', interval: 3 }, t, 'en')).toBe('Every 3 days');
  });

  it('sorts weekdays without changing the recurrence', () => {
    const byWeekday = [5, 1, 3];
    expect(describeRecurrence({ freq: 'daily', interval: 1, byWeekday }, t, 'en')).toBe('Every day on Mon, Wed, & Fri');
    expect(byWeekday).toEqual([5, 1, 3]);
  });

  it.each([
    [1, 'Every day'],
    [3, 'Every 3 days'],
  ] as const)('keeps interval %i unchanged with an empty weekday list', (interval, expected) => {
    expect(describeRecurrence({ freq: 'daily', interval, byWeekday: [] }, t, 'en')).toBe(expected);
  });

  it.each([
    [1, '每天的周一和周五'],
    [2, '每 2 天的周一和周五'],
  ] as const)('localizes daily weekdays in Chinese with interval %i', (interval, expected) => {
    const zh = createTranslator('zh-CN', buildMessages('zh-CN', appDictionaries));
    expect(describeRecurrence({ freq: 'daily', interval, byWeekday: [1, 5] }, zh, 'zh-CN')).toBe(expected);
  });
});

describe('recurrence end date timezones', () => {
  beforeEach(() => { vi.stubEnv('TZ', 'Asia/Singapore'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('formats until in the supplied timezone across the device date boundary', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Singapore');
    expect(describeRecurrence({ freq: 'daily', until: Date.parse('2026-10-28T00:25:00Z') }, t, 'en', 'America/New_York')).toBe('Every day · until Oct 27, 2026');
  });

  it('includes until at the Unix epoch in the supplied timezone', () => {
    expect(describeRecurrence({ freq: 'daily', until: 0 }, t, 'en', 'America/New_York')).toBe('Every day · until Dec 31, 1969');
  });

  it('omits the end date only when until is absent', () => {
    expect(describeRecurrence({ freq: 'daily' }, t, 'en', 'America/New_York')).toBe('Every day');
  });
});
