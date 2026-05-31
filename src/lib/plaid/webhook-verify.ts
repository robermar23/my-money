import "server-only";

import { createHash } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import type { JWKPublicKey } from "plaid";
import { plaidClient } from "./client.ts";

/**
 * P4-14 — Plaid webhook signature verification.
 *
 * Per CLAUDE.md §Plaid Safety Rules: every Plaid webhook MUST verify the
 * `Plaid-Verification` JWT before any side effect. The JWT is signed with
 * ES256; the public key is fetched per-`kid` from Plaid's
 * `/webhook_verification_key/get` and cached for 24 hours.
 *
 * Returns the parsed body on success, `null` on any failure (missing header,
 * unknown kid, bad signature, stale timestamp, body-hash mismatch, malformed
 * JSON). Callers respond 401 on null — without echoing details, per CLAUDE.md
 * "no leaking signature failure reasons to attackers."
 */

/** Plaid's documented webhook freshness window. */
const MAX_AGE_SECONDS = 5 * 60;
/** Clock-skew tolerance for `iat` claims slightly in the future. */
const FUTURE_SKEW_SECONDS = 10;
/** Cache TTL per ADR: 24h, then refetch. */
const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

interface CachedKey {
  jwk: JWKPublicKey;
  fetchedAt: number;
}

const keyCache = new Map<string, CachedKey>();

/** Test-only: clear the in-memory cache between specs. */
export function _resetKeyCacheForTests(): void {
  keyCache.clear();
}

async function loadKey(kid: string): Promise<JWKPublicKey | null> {
  const cached = keyCache.get(kid);
  if (cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL_MS) {
    return cached.jwk;
  }
  try {
    const resp = await plaidClient.webhookVerificationKeyGet({ key_id: kid });
    const jwk = resp.data.key;
    keyCache.set(kid, { jwk, fetchedAt: Date.now() });
    return jwk;
  } catch {
    // Plaid 404'd / network failure — caller treats as unknown kid → 401.
    return null;
  }
}

export interface VerifiedWebhook {
  /** Parsed JSON body. Caller already knows the rawBody too. */
  body: Record<string, unknown>;
}

/**
 * Verify a Plaid webhook delivery.
 *
 * @param headers - The incoming request headers.
 * @param rawBody - The raw body BYTES as a UTF-8 string. The signature is
 *   over the bytes Plaid sent, so the caller MUST read the body verbatim
 *   (no JSON round-trip beforehand).
 * @returns `{ body }` on success, `null` on any failure.
 */
export async function verifyWebhook(
  headers: Headers,
  rawBody: string,
): Promise<VerifiedWebhook | null> {
  // 1. Extract the JWT from the header. Plaid uses the case-sensitive form
  //    "Plaid-Verification"; Headers is case-insensitive so .get() handles it.
  const token = headers.get("plaid-verification");
  if (!token || token.length === 0) return null;

  // 2. Decode the protected header to get the kid (without verifying yet).
  let kid: string | undefined;
  try {
    const protectedHeader = decodeProtectedHeader(token);
    if (protectedHeader.alg !== "ES256") return null;
    kid = typeof protectedHeader.kid === "string" ? protectedHeader.kid : undefined;
  } catch {
    return null;
  }
  if (!kid) return null;

  // 3. Look up the public key (24h cache, refresh on miss).
  const jwk = await loadKey(kid);
  if (!jwk) return null;
  if (jwk.alg !== "ES256") return null;

  // 4. Verify the JWT signature using jose.
  let payload: Record<string, unknown>;
  try {
    const publicKey = await importJWK(jwk, "ES256");
    const verified = await jwtVerify(token, publicKey, {
      algorithms: ["ES256"],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    return null;
  }

  // 5. Enforce our own freshness window (Plaid's `iat` is the only timestamp).
  const iat = payload.iat;
  if (typeof iat !== "number") return null;
  const nowSec = Math.floor(Date.now() / 1_000);
  const age = nowSec - iat;
  if (age > MAX_AGE_SECONDS) return null;
  if (age < -FUTURE_SKEW_SECONDS) return null;

  // 6. Confirm the body the caller handed us is the body Plaid signed.
  const expectedHash = sha256Hex(rawBody);
  if (payload.request_body_sha256 !== expectedHash) return null;

  // 7. Parse the body — only AFTER signature + body-hash verification.
  let parsed: Record<string, unknown>;
  try {
    const json = JSON.parse(rawBody) as unknown;
    if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
    parsed = json as Record<string, unknown>;
  } catch {
    return null;
  }

  return { body: parsed };
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
