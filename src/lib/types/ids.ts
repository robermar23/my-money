/**
 * Branded ID types.
 *
 * Per CLAUDE.md §Project-Specific Guardrails — finance rewards strong types.
 * These nominal brands prevent accidentally passing a HoldingId where an
 * AccountId is expected, at compile time, with zero runtime cost.
 *
 * Usage:
 *   function load(id: AccountId): Promise<Account> { ... }
 *   const aid: AccountId = toAccountId(rawString);   // throws on non-UUID
 *   load(aid);                                       // OK
 *   load("some-string" as AccountId);                // works but defeats the safety
 */

type Branded<T, B> = T & { readonly __brand: B };

export type AccountId = Branded<string, "AccountId">;
export type HoldingId = Branded<string, "HoldingId">;
export type UserId = Branded<string, "UserId">;
export type LiabilityId = Branded<string, "LiabilityId">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, kind: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`Invalid ${kind}: ${value}`);
  }
}

export function toAccountId(raw: string): AccountId {
  assertUuid(raw, "AccountId");
  return raw as AccountId;
}
export function toHoldingId(raw: string): HoldingId {
  assertUuid(raw, "HoldingId");
  return raw as HoldingId;
}
export function toUserId(raw: string): UserId {
  assertUuid(raw, "UserId");
  return raw as UserId;
}
export function toLiabilityId(raw: string): LiabilityId {
  assertUuid(raw, "LiabilityId");
  return raw as LiabilityId;
}
