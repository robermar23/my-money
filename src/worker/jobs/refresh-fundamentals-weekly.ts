import { db } from "@/db/client.ts";
import { securities } from "@/db/schema/index.ts";
import { assetTypeFromPlaidType, upsertFundamentals } from "@/lib/investments/fundamentals.ts";
import { fetchFundamentals } from "@/lib/prices/yahoo-fundamentals.ts";
import type { Job } from "bullmq";
import { isNull, lt, or } from "drizzle-orm";

/**
 * Weekly security enrichment refresh (Phase 9, P9-07, ADR-020).
 *
 * Sector / industry / forward dividend change slowly, so this runs WEEKLY (not
 * with the daily price fetch). It refreshes only securities whose
 * `fundamentals_refreshed_at` is null or older than the staleness window, so a
 * second immediate run is a no-op (idempotent). Per-symbol failures don't abort
 * the batch — `fetchFundamentals` returns null on any error and we still stamp
 * the watermark (with a Plaid-type asset_type fallback) so the row drops out of
 * the stale set until next week.
 *
 * Privacy: only ticker symbols egress (see yahoo-fundamentals.ts).
 */

const STALE_DAYS = 7;

/** Injectable for tests (stub the network fetch). */
export interface RefreshFundamentalsDeps {
  readonly fetchFn?: typeof fetchFundamentals;
}

export async function refreshFundamentalsWeeklyProcessor(
  _job: Job,
  deps: RefreshFundamentalsDeps = {},
): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetchFundamentals;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - STALE_DAYS);

  const stale = await db
    .select({ id: securities.id, symbol: securities.symbol, type: securities.type })
    .from(securities)
    .where(
      or(
        isNull(securities.fundamentalsRefreshedAt),
        lt(securities.fundamentalsRefreshedAt, cutoff),
      ),
    );

  for (const s of stale) {
    const data = await fetchFn(s.symbol);
    // Yahoo asset type wins; fall back to the Plaid `type` mapping when absent.
    const assetType = data?.assetType ?? assetTypeFromPlaidType(s.type);
    await upsertFundamentals(s.id, { ...(data ?? {}), assetType });
  }
}
