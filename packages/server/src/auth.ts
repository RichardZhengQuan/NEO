/**
 * Auth middleware + IP rate limiter for failed attempts.
 */
import type { Context, Next } from 'hono';
import { systemClock } from '@neo/protocol';
import type { Clock, DeviceStore } from '@neo/protocol';
import './types.js';

/** Sliding-window per-IP failure counter. */
export class IpFailureLimiter {
  private readonly _windowMs = 60_000;
  private readonly _maxFailures = 10;
  private readonly _maxBuckets = 10_000;
  private readonly _sweepInterval = 100;
  private _failuresSinceSweep = 0;
  /** ip → array of failure timestamps */
  private readonly _failures = new Map<string, number[]>();

  constructor(private readonly clock: Clock = systemClock) {}

  isRateLimited(ip: string): boolean {
    const now = this.clock();
    const times = this._failures.get(ip) ?? [];
    const recent = times.filter((t) => now - t < this._windowMs);
    if (recent.length) this._failures.set(ip, recent);
    else this._failures.delete(ip);
    return recent.length >= this._maxFailures;
  }

  recordFailure(ip: string): void {
    const now = this.clock();
    // Sweep before the first failure in each batch, even when old IPs never return.
    if (this._failuresSinceSweep === 0) {
      for (const [key, times] of this._failures) {
        const recent = times.filter((t) => now - t < this._windowMs);
        if (recent.length) this._failures.set(key, recent);
        else this._failures.delete(key);
      }
    }
    this._failuresSinceSweep = (this._failuresSinceSweep + 1) % this._sweepInterval;

    const times = this._failures.get(ip) ?? [];
    const recent = times.filter((t) => now - t < this._windowMs);
    if (recent.length < this._maxFailures) recent.push(now);
    if (!this._failures.has(ip) && this._failures.size >= this._maxBuckets) {
      const oldest = this._failures.keys().next().value;
      if (oldest !== undefined) this._failures.delete(oldest);
    }
    this._failures.set(ip, recent);
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
