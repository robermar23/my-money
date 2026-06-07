import "server-only";

import { type Db, db } from "@/db/client.ts";
import { type NewSecurity, type Security, securities } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";

/**
 * P5-11 — Plaid `Security` → our `securities` row, plus the canonical-symbol
 * resolver that joins Plaid's `security_id` to our price/holdings world
 * (ADR-011/ADR-012).
 *
 * Canonical symbol precedence: `ticker_symbol` → `cusip` → `SEC:<security_id>`.
 * Tickered securities are priced by the daily Yahoo fetch; synthetic
 * `SEC:`-prefixed symbols are valued from Plaid's `institution_price`
 * (see investments-map.ts `institutionPriceQuote`).
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The Plaid `Security` fields we consume — a structural subset of the SDK type. */
export interface PlaidSecurityLike {
  readonly security_id: string;
  readonly ticker_symbol: string | null;
  readonly cusip: string | null;
  readonly name: string | null;
  readonly type: string | null;
  readonly is_cash_equivalent: boolean | null;
  readonly iso_currency_code: string | null;
}

/**
 * Resolve the canonical symbol for a Plaid security.
 *
 * @param s - The security's identifiers.
 * @returns ticker → cusip → `SEC:<security_id>`.
 */
export function resolveSymbol(
  s: Pick<PlaidSecurityLike, "ticker_symbol" | "cusip" | "security_id">,
): string {
  if (s.ticker_symbol && s.ticker_symbol.length > 0) return s.ticker_symbol;
  if (s.cusip && s.cusip.length > 0) return s.cusip;
  return `SEC:${s.security_id}`;
}

/** Pure map from a Plaid security to our insert row. */
export function mapSecurity(s: PlaidSecurityLike): NewSecurity {
  const symbol = resolveSymbol(s);
  return {
    plaidSecurityId: s.security_id,
    symbol,
    tickerSymbol: s.ticker_symbol,
    cusip: s.cusip,
    name: s.name && s.name.length > 0 ? s.name : symbol,
    type: s.type,
    isCashEquivalent: s.is_cash_equivalent ?? false,
    isoCurrencyCode: s.iso_currency_code ?? "USD",
    raw: s as unknown as Record<string, unknown>,
  };
}

/**
 * Insert or update a security by `plaid_security_id` (idempotent).
 *
 * @param s - The Plaid security.
 * @param txOrDb - Optional transaction; defaults to the shared client.
 * @returns The persisted `securities` row.
 */
export async function upsertSecurity(
  s: PlaidSecurityLike,
  txOrDb: Tx | Db = db,
): Promise<Security> {
  const values = mapSecurity(s);
  const [row] = await txOrDb
    .insert(securities)
    .values(values)
    .onConflictDoUpdate({
      target: securities.plaidSecurityId,
      // Match the partial unique index predicate so Postgres infers it.
      targetWhere: sql`${securities.plaidSecurityId} is not null`,
      set: {
        symbol: values.symbol,
        tickerSymbol: values.tickerSymbol,
        cusip: values.cusip,
        name: values.name,
        type: values.type,
        isCashEquivalent: values.isCashEquivalent,
        isoCurrencyCode: values.isoCurrencyCode,
        raw: values.raw,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) {
    throw new Error("upsertSecurity: no row returned");
  }
  return row;
}
