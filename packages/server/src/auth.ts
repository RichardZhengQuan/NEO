/**
 * Auth middleware + IP rate limiter for failed attempts.
 */
import type { Context, Next } from 'hono';
import { systemClock } from '@neo/protocol';
import type { Clock, DeviceStore } from '@neo/protocol';
import './types.js';

/** Indexed min-heap: updates and removals keep one entry per retained IP. */
class IpBucketHeap {
  private readonly _ips: string[] = [];
  private readonly _positions = new Map<string, number>();

  constructor(private readonly precedes: (a: string, b: string) => boolean) {}

  peek(): string | undefined { return this._ips[0]; }

  update(ip: string): void {
    let index = this._positions.get(ip);
    if (index === undefined) {
      index = this._ips.length;
      this._ips.push(ip);
      this._positions.set(ip, index);
    }
    this.reposition(index);
  }

  delete(ip: string): void {
    const index = this._positions.get(ip);
    if (index === undefined) return;
    const last = this._ips.pop()!;
    this._positions.delete(ip);
    if (index < this._ips.length) {
      this._ips[index] = last;
      this._positions.set(last, index);
      this.reposition(index);
    }
  }

  private reposition(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.precedes(this._ips[index]!, this._ips[parent]!)) break;
      this.swap(index, parent);
      index = parent;
    }
    for (;;) {
      const left = index * 2 + 1;
      if (left >= this._ips.length) break;
      const right = left + 1;
      const child = right < this._ips.length && this.precedes(this._ips[right]!, this._ips[left]!) ? right : left;
      if (!this.precedes(this._ips[child]!, this._ips[index]!)) break;
      this.swap(index, child);
      index = child;
    }
  }

  private swap(a: number, b: number): void {
    [this._ips[a], this._ips[b]] = [this._ips[b]!, this._ips[a]!];
    this._positions.set(this._ips[a]!, a);
    this._positions.set(this._ips[b]!, b);
  }
}

/** Sliding-window per-IP failure counter. */
export class IpFailureLimiter {
  private readonly _windowMs = 60_000;
  private readonly _maxFailures = 10;
  private readonly _maxBuckets = 10_000;
  /** ip → array of failure timestamps */
  private readonly _failures = new Map<string, number[]>();
  private readonly _order = new Map<string, number>();
  private _nextOrder = 0;
  /** Blocked buckets stay in the expiry heap but cannot be eviction victims. */
  private readonly _eviction = new IpBucketHeap((a, b) => {
    const left = this._failures.get(a)!;
    const right = this._failures.get(b)!;
    return (left.length - right.length || Math.max(...left) - Math.max(...right) || this._order.get(a)! - this._order.get(b)!) < 0;
  });
  private readonly _expiry = new IpBucketHeap((a, b) => {
    return (Math.min(...this._failures.get(a)!) - Math.min(...this._failures.get(b)!) || this._order.get(a)! - this._order.get(b)!) < 0;
  });

  constructor(private readonly clock: Clock = systemClock) {}

  isRateLimited(ip: string): boolean {
    const now = this.clock();
    const times = this._failures.get(ip) ?? [];
    const recent = times.filter((t) => now - t < this._windowMs);
    if (recent.length) this.setBucket(ip, recent);
    else this.deleteBucket(ip);
    return recent.length >= this._maxFailures;
  }

  recordFailure(ip: string): void {
    const now = this.clock();
    // Refresh every due bucket before ranking victims, including partial expiry.
    // Each expiry consumes a recorded timestamp: O(log cap) amortized per failure.
    for (let key = this._expiry.peek(); key !== undefined; key = this._expiry.peek()) {
      const times = this._failures.get(key)!;
      if (now - Math.min(...times) < this._windowMs) break;
      const recent = times.filter((t) => now - t < this._windowMs);
      if (recent.length) this.setBucket(key, recent);
      else this.deleteBucket(key);
    }

    const times = this._failures.get(ip) ?? [];
    if (times.length < this._maxFailures) times.push(now);
    if (!this._failures.has(ip) && this._failures.size >= this._maxBuckets) {
      const victim = this._eviction.peek();
      // All retained buckets are blocked: preserve them without growing the table.
      if (victim === undefined) return;
      this.deleteBucket(victim);
    }
    this.setBucket(ip, times);
  }

  private setBucket(ip: string, times: number[]): void {
    if (!this._order.has(ip)) this._order.set(ip, this._nextOrder++);
    this._failures.set(ip, times);
    if (times.length < this._maxFailures) this._eviction.update(ip);
    else this._eviction.delete(ip);
    this._expiry.update(ip);
  }

  private deleteBucket(ip: string): void {
    this._eviction.delete(ip);
    this._expiry.delete(ip);
    this._failures.delete(ip);
    this._order.delete(ip);
  }
}

export const ipLimiter = new IpFailureLimiter();

/** Extract bearer token from Authorization header. */
export function extractBearerToken(c: Context): string | null {
  const h = c.req.header('authorization') ?? '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return null;
}

/** Get the real client IP, optionally trusting X-Forwarded-For. */
export function getClientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for');
    const realIp = c.req.header('x-real-ip');
    if (forwarded?.split(',')[0]?.trim()) return forwarded.split(',')[0]!.trim();
    if (realIp?.trim()) return realIp.trim();
  }
  // Hono provides conninfo via c.env
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? '127.0.0.1';
}

/** Creates Hono auth middleware that checks bearer token and rate-limits failed attempts. */
export function createAuthMiddleware(devices: DeviceStore, trustProxy = false, clock: Clock = systemClock, limiter = new IpFailureLimiter(clock)) {
  // Keep failures scoped to this app; restarting one server must not affect another.
  return async (c: Context, next: Next) => {
    const ip = getClientIp(c, trustProxy);
    const token = extractBearerToken(c);
    const device = token ? devices.verify(token) : null;
    // Anonymous failures must never lock out a verified credential on a shared IP.
    if (device) {
      c.set('device', device);
      await next();
      return;
    }
    if (limiter.isRateLimited(ip)) {
      c.header('Retry-After', '60');
      return c.json({ code: 'rate_limited', message: 'Too many failed auth attempts', retryable: true }, 429);
    }

    limiter.recordFailure(ip);
    return c.json({ code: 'unauthorized', message: token ? 'Invalid token' : 'Missing bearer token' }, 401);
  };
}

/** Middleware that only allows the owner device. */
export function ownerOnly() {
  return async (c: Context, next: Next) => {
    const device = c.get('device');
    if (!device?.owner) {
      return c.json({ code: 'forbidden', message: 'Owner access required' }, 403);
    }
    await next();
  };
}
