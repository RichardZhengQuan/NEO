import { describe, expect, it } from 'vitest';
import { IpFailureLimiter } from './auth.js';

describe('IpFailureLimiter', () => {
  it('evicts expired buckets without requests from the same IPs', () => {
    let t = 0;
    const clock = () => t;
    const limiter = new IpFailureLimiter(clock);
    for (let i = 0; i < 1_000; i++) limiter.recordFailure(`2001:db8::${i.toString(16)}`);
    expect(limiter['_failures'].size).toBe(1_000);

    t = 60_001;
    limiter.recordFailure('2001:db8::ffff');

    expect(limiter['_failures'].size).toBeLessThanOrEqual(1);
    expect(limiter['_failures'].has('2001:db8::ffff')).toBe(true);
  });

  it('caps retained buckets at 10,000 and evicts the oldest insertion', () => {
    const limiter = new IpFailureLimiter(() => 0);
    for (let i = 0; i < 10_000; i++) limiter.recordFailure(`2001:db8::${i.toString(16)}`);

    // Updating an existing bucket at capacity must not evict another IP.
    for (let i = 0; i < 20; i++) limiter.recordFailure('2001:db8::0');
    expect(limiter['_failures'].size).toBe(10_000);
    expect(limiter['_failures'].get('2001:db8::0')).toHaveLength(10);
    expect(limiter['_failures'].has('2001:db8::1')).toBe(true);

    for (let i = 10_000; i < 10_005; i++) {
      limiter.recordFailure(`2001:db8::${i.toString(16)}`);
      expect(limiter['_failures'].size).toBe(10_000);
    }
    for (let i = 0; i < 5; i++) expect(limiter['_failures'].has(`2001:db8::${i.toString(16)}`)).toBe(false);
    expect(limiter['_failures'].has('2001:db8::5')).toBe(true);
    expect(limiter['_failures'].has('2001:db8::2714')).toBe(true);
  });

  it('sweeps at the window boundary while preserving active failures', () => {
    let t = 0;
    const limiter = new IpFailureLimiter(() => t);
    for (let i = 0; i < 90; i++) limiter.recordFailure(`2001:db8::${i.toString(16)}`);
    limiter.recordFailure('active');

    t = 1;
    for (let i = 0; i < 9; i++) limiter.recordFailure('active');
    expect(limiter.isRateLimited('active')).toBe(true);

    t = 60_000;
    limiter.recordFailure('new');

    expect(limiter['_failures'].size).toBe(2);
    expect(limiter['_failures'].get('active')).toEqual(Array(9).fill(1));
    expect(limiter.isRateLimited('active')).toBe(false);
    limiter.recordFailure('active');
    expect(limiter.isRateLimited('active')).toBe(true);
  });
});
