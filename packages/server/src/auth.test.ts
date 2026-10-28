import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceStore } from '@neo/protocol';
import { createAuthMiddleware, IpFailureLimiter } from './auth.js';

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

  it('caps retained buckets at 10,000 and evicts the least valuable active buckets', () => {
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
    expect(limiter['_failures'].has('2001:db8::0')).toBe(true);
    for (let i = 1; i <= 5; i++) expect(limiter['_failures'].has(`2001:db8::${i.toString(16)}`)).toBe(false);
    expect(limiter['_failures'].has('2001:db8::6')).toBe(true);
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

  it('preserves a blocked IP through more than 10,000 fresh IP failures inside the window', () => {
    let t = 0;
    const limiter = new IpFailureLimiter(() => t);
    for (let i = 0; i < 10; i++) limiter.recordFailure('blocked');
    expect(limiter.isRateLimited('blocked')).toBe(true);

    for (let i = 0; i < 15_000; i++) {
      t = i + 1;
      limiter.recordFailure(`2001:db8::${i.toString(16)}`);
      expect(limiter['_failures'].size).toBeLessThanOrEqual(10_000);
    }

    expect(limiter['_failures'].size).toBe(10_000);
    expect(limiter['_failures'].has('2001:db8::0')).toBe(false);
    expect(limiter.isRateLimited('blocked')).toBe(true);
  });

  it('evicts expired buckets before active ones at capacity between periodic sweeps', () => {
    let t = 0;
    const limiter = new IpFailureLimiter(() => t);
    limiter.recordFailure('active');
    limiter.recordFailure('expired');
    t = 1;
    limiter.recordFailure('active');
    for (let i = 0; i < 9_998; i++) limiter.recordFailure(`filler-${i}`);
    expect(limiter['_failures'].size).toBe(10_000);

    t = 60_000;
    limiter.recordFailure('new');

    expect(limiter['_failures'].has('expired')).toBe(false);
    expect(limiter['_failures'].get('active')).toEqual([1]);
    expect(limiter['_failures'].has('new')).toBe(true);
    expect(limiter['_failures'].size).toBe(10_000);
  });

  it('updates an existing bucket at capacity without evicting any IP', () => {
    const limiter = new IpFailureLimiter(() => 0);
    for (let i = 0; i < 10_000; i++) limiter.recordFailure(`ip-${i}`);
    const retained = [...limiter['_failures'].keys()];

    for (let i = 0; i < 20; i++) limiter.recordFailure('ip-5000');

    expect([...limiter['_failures'].keys()]).toEqual(retained);
    expect(limiter['_failures'].get('ip-5000')).toHaveLength(10);
    expect(limiter.isRateLimited('ip-5000')).toBe(true);
  });

  it('records a newcomer until blocked when capacity holds two-failure buckets', () => {
    const limiter = new IpFailureLimiter(() => 0);
    for (let i = 0; i < 10_000; i++) {
      limiter.recordFailure(`ip-${i}`);
      limiter.recordFailure(`ip-${i}`);
    }
    expect(limiter['_failures'].size).toBe(10_000);

    for (let failures = 1; failures <= 10; failures++) {
      limiter.recordFailure('new');
      expect(limiter['_failures'].get('new')).toHaveLength(failures);
      expect(limiter['_failures'].size).toBe(10_000);
      expect(limiter.isRateLimited('new')).toBe(failures === 10);
    }

    expect(limiter['_failures'].has('ip-0')).toBe(false);
    expect(limiter['_failures'].get('ip-1')).toEqual([0, 0]);
  });

  it.each(['recordFailure', 'isRateLimited'] as const)('makes a partly expired blocked bucket evictable again via %s', (refresh) => {
    let t = 1;
    const limiter = new IpFailureLimiter(() => t);
    for (let i = 0; i < 9_999; i++) {
      for (let j = 0; j < 10; j++) limiter.recordFailure(`blocked-${i}`);
    }
    t = 0;
    limiter.recordFailure('formerly-blocked');
    t = 1;
    for (let i = 0; i < 9; i++) limiter.recordFailure('formerly-blocked');
    expect(limiter.isRateLimited('formerly-blocked')).toBe(true);
    expect(limiter['_failures'].size).toBe(10_000);

    t = 60_000;
    if (refresh === 'isRateLimited') {
      expect(limiter.isRateLimited('formerly-blocked')).toBe(false);
      expect(limiter['_failures'].get('formerly-blocked')).toEqual(Array(9).fill(1));
    }
    limiter.recordFailure('new');

    expect(limiter['_failures'].has('formerly-blocked')).toBe(false);
    expect(limiter['_failures'].get('new')).toEqual([60_000]);
    expect(limiter['_failures'].size).toBe(10_000);
    for (let i = 0; i < 9_999; i++) expect(limiter.isRateLimited(`blocked-${i}`)).toBe(true);
  });

  it('evicts by recent failure count and then oldest last failure after partial expiry', () => {
    let t = 0;
    const limiter = new IpFailureLimiter(() => t);
    for (let i = 0; i < 9; i++) limiter.recordFailure('recent');
    t = 1;
    limiter.recordFailure('oldest-last-failure');
    t = 2;
    limiter.recordFailure('recent');
    for (let i = 0; i < 9_998; i++) {
      limiter.recordFailure(`filler-${i}`);
      limiter.recordFailure(`filler-${i}`);
    }
    expect(limiter.isRateLimited('recent')).toBe(true);
    expect(limiter['_failures'].size).toBe(10_000);

    t = 60_000;
    limiter.recordFailure('new-1');
    expect(limiter['_failures'].has('oldest-last-failure')).toBe(false);
    expect(limiter['_failures'].get('recent')).toEqual([2]);
    limiter.recordFailure('new-2');
    expect(limiter['_failures'].has('recent')).toBe(false);
    expect(limiter['_failures'].has('new-1')).toBe(true);
    expect(limiter['_failures'].get('filler-0')).toEqual([2, 2]);
    expect(limiter['_failures'].size).toBe(10_000);
  });

  it('preserves every blocked bucket when capacity has no lower-value victim', () => {
    const limiter = new IpFailureLimiter(() => 0);
    for (let i = 0; i < 10_000; i++) {
      for (let j = 0; j < 10; j++) limiter.recordFailure(`blocked-${i}`);
    }

    limiter.recordFailure('new');

    expect(limiter['_failures'].has('new')).toBe(false);
    expect(limiter['_failures'].size).toBe(10_000);
    for (let i = 0; i < 10_000; i++) expect(limiter.isRateLimited(`blocked-${i}`)).toBe(true);
  });

  it('removes expiry bookkeeping after isRateLimited prunes a bucket, including clock rollback', () => {
    let t = 100_000;
    const limiter = new IpFailureLimiter(() => t);
    limiter.recordFailure('out-of-order');
    t = 0;
    limiter.recordFailure('out-of-order');
    t = 1;
    limiter.recordFailure('active');
    t = 0;
    for (let i = 0; i < 9_998; i++) limiter.recordFailure(`expired-${i}`);
    expect(limiter['_failures'].size).toBe(10_000);

    t = 60_001;
    expect(limiter.isRateLimited('active')).toBe(false);
    expect(limiter['_failures'].has('active')).toBe(false);
    limiter.recordFailure('new');

    expect(limiter['_failures'].get('out-of-order')).toEqual([100_000]);
    expect(limiter['_failures'].size).toBe(2);
    expect(limiter['_failures'].get('new')).toEqual([60_001]);
  });
});

describe('createAuthMiddleware', () => {
  it('returns 429 for a blocked IP after a fresh-address flood at capacity', async () => {
    let t = 0;
    const clock = () => t;
    const limiter = new IpFailureLimiter(clock);
    const devices: DeviceStore = {
      list: () => [],
      create: () => { throw new Error('unused'); },
      verify: vi.fn(() => null),
      revoke: () => false,
    };
    const app = new Hono();
    app.use('/protected', createAuthMiddleware(devices, true, clock, limiter));
    app.get('/protected', (c) => c.text('authenticated'));
    const request = (ip: string) => app.request('/protected', {
      headers: { Authorization: 'Bearer invalid-token', 'X-Forwarded-For': ip },
    });
    for (let i = 0; i < 10; i++) expect((await request('2001:db8::ffff')).status).toBe(401);
    expect((await request('2001:db8::ffff')).status).toBe(429);

    for (let i = 0; i < 15_000; i++) {
      t = i + 1;
      expect((await request(`2001:db8::${i.toString(16)}`)).status).toBe(401);
      expect(limiter['_failures'].size).toBeLessThanOrEqual(10_000);
    }

    expect(limiter['_failures'].size).toBe(10_000);
    expect(devices.verify).toHaveBeenCalledTimes(15_011);
    const blocked = await request('2001:db8::ffff');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
    expect(await blocked.json()).toMatchObject({ code: 'rate_limited' });
  });
});
