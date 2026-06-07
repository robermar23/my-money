import "server-only";

import { RateLimiter, bucketKeyFromHeaders } from "@/lib/security/rate-limit.ts";
import { headers } from "next/headers";

/**
 * Per-IP throttle for the login / first-run-bootstrap action (P6-01/02).
 *
 * The password is the single gate to all financial data, and once the
 * Cloudflare Tunnel is up (ADR-010) the app — including `/login` — is reachable
 * from the internet. argon2id makes each guess expensive, but a throttle is
 * cheap defense-in-depth: it caps automated guessing *and* the CPU-exhaustion
 * cost of forcing many argon2 verifications.
 *
 * 10 attempts/minute/IP is generous for a human typing a password and tight for
 * a bruteforcer. Combined with argon2id, online guessing is infeasible.
 */
const loginLimiter = new RateLimiter({ capacity: 10, windowMs: 60_000 });

/**
 * Consume one login attempt for the caller's source IP.
 *
 * @returns `true` if the attempt is allowed; `false` if the caller is over the
 *   limit and the action should reject before doing any password work.
 */
export async function allowLoginAttempt(): Promise<boolean> {
  const key = bucketKeyFromHeaders(await headers());
  return loginLimiter.consume(key);
}

/** Test-only: reset the throttle between cases. */
export function _resetLoginThrottle(): void {
  loginLimiter._reset();
}
