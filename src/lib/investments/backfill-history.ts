import "server-only";

import { db } from "@/db/client.ts";
import { accounts, holdingLots, holdingSnapshots, holdings, prices } from "@/db/schema/index.ts";
import { resolveCostBasis } from "@/lib/investments/lots.ts";
import Decimal from "decimal.js";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

/**
 * Best-effort historical backfill for `holding_snapshots` (PLAN9 P9-03,
 * ADR-019).
 *
 * For each holding, write one snapshot per date the `prices` table already
 * covers for its symbol (bounded to `windowMonths`, default 24), valued as
 * `current_quantity × close`.
 *
 * **This is an approximation.** Plaid reports *current* holdings, not historical
 * positions, so past *quantity* isn't reconstructed — we project today's
 * quantity onto past prices. Going forward, the nightly compute-snapshots-daily
 * job records the *actual* quantity each day (P9-02), so accuracy improves from
 * the deploy date onward. An exact transaction-replay backfill is logged as a
 * PLAN9 Open Item, not built (YAGNI for one user with limited history).
 *
 * Cash/property positions have no `prices` rows, so they get no historical
 * rows here — they're captured at face value going forward by the nightly job.
 *
 * Idempotent: upserts on the `(holding_id, date)` PK, so re-running changes
 * nothing. Exposed via `src/worker/run-once.ts`. Take a `pg_dump` first
 * (docs/BACKUP.md) before running on real data.
 */
export interface BackfillHistoryResult {
  readonly holdingsProcessed: number;
  readonly snapshotsWritten: number;
}

/** ISO date (YYYY-MM-DD) `months` before today, UTC. */
function windowStart(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

export async function backfillHoldingSnapshots(windowMonths = 24): Promise<BackfillHistoryResult> {
  const from = windowStart(windowMonths);

  const rows = await db
    .select({ holding: holdings, currency: accounts.currency })
    .from(holdings)
    .innerJoin(accounts, eq(holdings.accountId, accounts.id));
  if (rows.length === 0) return { holdingsProcessed: 0, snapshotsWritten: 0 };

  // Load all lots for these holdings once, grouped for cost-basis resolution.
  const lotRows = await db
    .select({
      holdingId: holdingLots.holdingId,
      quantity: holdingLots.quantity,
      costBasisTotal: holdingLots.costBasisTotal,
    })
    .from(holdingLots)
    .where(
      inArray(
        holdingLots.holdingId,
        rows.map((r) => r.holding.id),
      ),
    );
  const lotsByHolding = new Map<string, { quantity: string; costBasisTotal: string }[]>();
  for (const lot of lotRows) {
    const arr = lotsByHolding.get(lot.holdingId) ?? [];
    arr.push({ quantity: lot.quantity, costBasisTotal: lot.costBasisTotal });
    lotsByHolding.set(lot.holdingId, arr);
  }

  let snapshotsWritten = 0;
  for (const { holding: h, currency } of rows) {
    const isCashLike = h.assetClass === "cash" || h.assetClass === "property";
    const costBasis = isCashLike
      ? null
      : resolveCostBasis({ costBasis: h.costBasis }, lotsByHolding.get(h.id) ?? [], currency);
    const basis = costBasis ? costBasis.toString() : null;

    // Every dated close we have for this symbol within the window.
    const priceRows = await db
      .select({ date: prices.date, close: prices.close })
      .from(prices)
      .where(and(eq(prices.symbol, h.symbol), gte(prices.date, from)));

    if (priceRows.length === 0) continue;

    const quantity = new Decimal(h.quantity);
    const values = priceRows.map((p) => ({
      holdingId: h.id,
      date: p.date,
      quantity: h.quantity,
      value: quantity.times(new Decimal(p.close)).toFixed(2),
      costBasis: basis,
      currency,
    }));

    await db
      .insert(holdingSnapshots)
      .values(values)
      .onConflictDoUpdate({
        target: [holdingSnapshots.holdingId, holdingSnapshots.date],
        set: {
          quantity: sql`excluded.quantity`,
          value: sql`excluded.value`,
          costBasis: sql`excluded.cost_basis`,
          currency: sql`excluded.currency`,
        },
      });
    snapshotsWritten += values.length;
  }

  return { holdingsProcessed: rows.length, snapshotsWritten };
}
