import type { RequestHandler } from 'express';

/**
 * In-memory fixed-window counter per key (normally the client IP). Enough for a single
 * instance; a multi-instance deployment would move this to a shared store.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Records one hit and reports whether the key is still within its limit. */
  hit(key: string): { allowed: boolean; retryAfterSec: number } {
    const now = this.clock();
    this.sweep(now);
    const cur = this.hits.get(key);
    if (!cur || now - cur.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: now, count: 1 });
      return { allowed: true, retryAfterSec: 0 };
    }
    cur.count += 1;
    const retryAfterSec = Math.ceil((cur.windowStart + this.windowMs - now) / 1000);
    return { allowed: cur.count <= this.limit, retryAfterSec };
  }

  /** True when the key is already over its limit, without recording a hit. */
  blocked(key: string): boolean {
    const cur = this.hits.get(key);
    return Boolean(cur && this.clock() - cur.windowStart < this.windowMs && cur.count > this.limit);
  }

  private sweep(now: number) {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [k, v] of this.hits) if (now - v.windowStart >= this.windowMs) this.hits.delete(k);
  }
}

export function rateLimit(limiter: RateLimiter, message: string): RequestHandler {
  return (req, res, next) => {
    const r = limiter.hit(req.ip ?? 'unknown');
    if (r.allowed) return next();
    res.setHeader('Retry-After', String(r.retryAfterSec));
    res.status(429).json({ error: 'RATE_LIMITED', message });
  };
}
