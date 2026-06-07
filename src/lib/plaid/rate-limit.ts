import "server-only";

import { RateLimiter } from "@/lib/security/rate-limit.ts";

/**
 * P4-16 — token-bucket rate limiter for the Plaid webhook route.
 *
 * The generic `RateLimiter` + `bucketKeyFromHeaders` were relocated to
 * `src/lib/security/rate-limit.ts` in the Phase 6 pre-deploy pass so the login
 * surface can reuse them (P6-01/02). They are re-exported here so existing
 * Plaid imports keep working unchanged.
 */
export {
  RateLimiter,
  bucketKeyFromHeaders,
  type RateLimitOpts,
} from "@/lib/security/rate-limit.ts";

/**
 * Singleton limiter for the Plaid webhook route. 100 req/min/IP by default.
 *
 * In-process, so tests import this directly and call `_reset()` between cases.
 */
export const plaidWebhookLimiter = new RateLimiter({ capacity: 100, windowMs: 60_000 });
