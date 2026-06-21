import "server-only";

import { db } from "@/db/client.ts";
import { securities } from "@/db/schema/index.ts";
import type { SecurityFundamentals } from "@/lib/prices/yahoo-fundamentals.ts";
import { eq } from "drizzle-orm";

/**
 * Enrichment store (Phase 9, ADR-020): writes the fundamentals columns onto a
 * `securities` row and stamps the `fundamentals_refreshed_at` watermark.
 *
 * `securities.raw` (the Plaid payload) is intentionally left untouched.
 */

/** Each field optional so callers can omit what they don't have. */
export type FundamentalsUpdate = Partial<SecurityFundamentals>;

/**
 * Map a Plaid security `type` to our normalized `asset_type` — the fallback when
 * Yahoo returns no `quoteType` (synthetic / crypto / metals / patchy coverage).
 *
 * @param plaidType - Plaid's security `type` (or null).
 * @returns A bucket from the schema CHECK, or null when nothing is known.
 */
export function assetTypeFromPlaidType(plaidType: string | null): string | null {
  switch ((plaidType ?? "").toLowerCase()) {
    case "equity":
      return "equity";
    case "etf":
      return "etf";
    case "mutual fund":
      return "mutual_fund";
    case "fixed income":
      return "bond";
    case "cash":
      return "cash";
    case "cryptocurrency":
      return "crypto";
    case "":
      return null;
    default:
      return "other";
  }
}

/**
 * Write enrichment fields + the refresh watermark for one security.
 *
 * @param securityId - The security to update.
 * @param data - Fundamentals (absent fields are written NULL).
 */
export async function upsertFundamentals(
  securityId: string,
  data: FundamentalsUpdate,
): Promise<void> {
  await db
    .update(securities)
    .set({
      sector: data.sector ?? null,
      industry: data.industry ?? null,
      region: data.region ?? null,
      assetType: data.assetType ?? null,
      expenseRatio: data.expenseRatio ?? null,
      dividendRate: data.dividendRate ?? null,
      dividendExDate: data.dividendExDate ?? null,
      fundamentalsRefreshedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(securities.id, securityId));
}
