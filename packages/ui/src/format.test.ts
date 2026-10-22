import { describe, expect, it } from 'vitest';
import { dayKey, formatDate, formatDateTime, formatTime } from './format.js';

describe('format out-of-range guards', () => {
  it.each([1e20, -1e20, NaN, Infinity, -Infinity])('formatDateTime returns — without throwing for %s', (ms) => {
    const result = formatDateTime(ms, 'en-US', 'UTC');
    expect(result).toBeTypeOf('string');
    expect(result).toBe('—');
  });

  it.each([1e20, -1e20, NaN, Infinity, -Infinity])('formatDate returns — for %s', (ms) => {
    expect(formatDate(ms, 'en-US', 'UTC')).toBe('—');
  });

  it.each([1e20, -1e20, NaN, Infinity, -Infinity])('formatTime returns — for %s', (ms) => {
    expect(formatTime(ms, 'en-US', 'UTC')).toBe('—');
  });

  it.each([1e20, -1e20, NaN, Infinity, -Infinity])('dayKey returns 0000-00-00 for %s', (ms) => {
    expect(dayKey(ms, 'UTC')).toBe('0000-00-00');
  });

  it('formats an in-range epoch without sentinels', () => {
    const ms = 1_765_000_000_000;
    expect(formatDateTime(ms, 'en-US', 'UTC')).not.toBe('—');
    expect(formatDate(ms, 'en-US', 'UTC')).not.toBe('—');
    expect(formatTime(ms, 'en-US', 'UTC')).not.toBe('—');
    expect(dayKey(ms, 'UTC')).not.toBe('0000-00-00');
  });
});
