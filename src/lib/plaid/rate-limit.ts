import "server-only";

/**
 * P4-16 — In-process token-bucket rate limiter for the Plaid webhook route.
 *
 * Single-user app, low attacker volume. A 20-line LRU is enough — `@upstash/
 * ratelimit` would be overkill (and adds an external Redis hop for a check
 * that can be done locally).
 *
 * The limiter is keyed by the request's source IP, derived from the standard
 * `x-forwarded-for` chain (with `x-real-ip` fallback). When neither is set
 * — local dev — we bucket under `'local'`.
 *
 * Tokens refill linearly at `capacity / windowMs` per millisecond. A request
 * costs 1 token; an empty bucket means 429.
 */

export interface RateLimitOpts {
  /** Maximum requests per window. Default 100. */
  capacity?: number;
  /** Window length in ms. Default 60_000 (1 minute). */
  windowMs?: number;
  /** Hard cap on tracked IPs. Default 1024 — well above any plausible burst. */
  maxKeys?: number;
}

interface Bucket {
  /** Tokens remaining (float; refilled continuously). */
  tokens: number;
  /** Last update timestamp in ms. */
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillRatePerMs: number;
  private readonly maxKeys: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: RateLimitOpts = {}) {
    this.capacity = opts.capacity ?? 100;
    const windowMs = opts.windowMs ?? 60_000;
    this.refillRatePerMs = this.capacity / windowMs;
    this.maxKeys = opts.maxKeys ?? 1024;
  }

  /** Returns true if the request is allowed; false if it must be rejected with 429. */
  consume(key: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Evict the oldest entry if we're at the key cap. Map iteration order is
      // insertion order, so the first key is the oldest by first-seen.
      if (this.buckets.size >= this.maxKeys) {
        const firstKey = this.buckets.keys().next().value;
        if (firstKey !== undefined) this.buckets.delete(firstKey);
      }
      bucket = { tokens: this.capacity, lastRefillMs: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = now - bucket.lastRefillMs;
      if (elapsed > 0) {
        bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillRatePerMs);
        bucket.lastRefillMs = now;
      }
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Test-only: dump current bucket state. */
  _peek(key: string): { tokens: number } | undefined {
    const b = this.buckets.get(key);
    return b ? { tokens: b.tokens } : undefined;
  }

  /** Test-only: reset all buckets. */
  _reset(): void {
    this.buckets.clear();
  }
}

/**
 * Singleton limiter for the Plaid webhook route. 100 req/min/IP by default.
 *
 * The plain text export is fine because the limiter is in-process; tests
 * import this directly and call `_reset()` between cases.
 */
export const plaidWebhookLimiter = new RateLimiter({ capacity: 100, windowMs: 60_000 });

/**
 * Derive a stable per-source bucket key from request headers.
 *
 * Behind Cloudflare Tunnel (ADR-010), the original client IP arrives in
 * `cf-connecting-ip`. Without a CDN, `x-forwarded-for` (proxy chain) /
 * `x-real-ip` cover most reverse-proxy setups. Local dev falls back to
 * `'local'`.
 */
export function bucketKeyFromHeaders(headers: Headers): string {
  const cfip = headers.get("cf-connecting-ip");
  if (cfip) return cfip.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    // First entry is the client, subsequent are proxies.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xreal = headers.get("x-real-ip");
  if (xreal) return xreal.trim();
  return "local";
}
