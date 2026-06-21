// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, holdingSnapshots, holdings, prices } from "@/db/schema/index.ts";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { backfillHoldingSnapshots } from "./backfill-history.ts";

/**
 * P9-03 — best-effort history backfill: one snapshot per priced date,
 * `current_quantity × close`, idempotent, and a graceful no-op for symbols with
 * no price rows.
 */

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE holding_snapshots, holding_lots, holdings, accounts, prices CASCADE`,
  );
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function seedAccount(): Promise<string> {
  const [a] = await db
    .insert(accounts)
    .values({ name: "Brokerage", institution: "Fidelity", type: "investment", currency: "USD" })
    .returning({ id: accounts.id });
  if (!a) throw new Error("seed account failed");
  return a.id;
}

describe("backfillHoldingSnapshots (P9-03)", () => {
  beforeEach(reset);
  afterAll(reset);

  it("writes one snapshot per priced date and is idempotent", async () => {
    const accountId = await seedAccount();
    const [h] = await db
      .insert(holdings)
      .values({
        accountId,
        symbol: "AAPL",
        quantity: "2",
        quantityUnit: "shares",
        assetClass: "equity",
        costBasis: "100.00",
      })
      .returning({ id: holdings.id });
    if (!h) throw new Error("seed holding failed");

    const d1 = isoDaysAgo(3);
    const d2 = isoDaysAgo(2);
    const d3 = isoDaysAgo(1);
    await db.insert(prices).values([
      { symbol: "AAPL", date: d1, close: "100" },
      { symbol: "AAPL", date: d2, close: "110" },
      { symbol: "AAPL", date: d3, close: "120" },
    ]);

    const res = await backfillHoldingSnapshots();
    expect(res.holdingsProcessed).toBe(1);
    expect(res.snapshotsWritten).toBe(3);

    const snaps = await db
      .select()
      .from(holdingSnapshots)
      .where(eq(holdingSnapshots.holdingId, h.id))
      .orderBy(asc(holdingSnapshots.date));
    expect(snaps).toHaveLength(3);
    expect(snaps.map((s) => s.value)).toEqual(["200.00", "220.00", "240.00"]); // qty 2 × close
    expect(snaps[0]?.costBasis).toBe("100.00");

    // Re-running changes no row count and leaves values stable.
    await backfillHoldingSnapshots();
    const after = await db
      .select()
      .from(holdingSnapshots)
      .where(eq(holdingSnapshots.holdingId, h.id));
    expect(after).toHaveLength(3);
  });

  it("yields zero snapshots for a holding whose symbol has no prices", async () => {
    const accountId = await seedAccount();
    await db.insert(holdings).values({
      accountId,
      symbol: "NOPRICE",
      quantity: "5",
      quantityUnit: "shares",
      assetClass: "equity",
    });

    const res = await backfillHoldingSnapshots();
    expect(res.holdingsProcessed).toBe(1);
    expect(res.snapshotsWritten).toBe(0);
    expect(await db.select().from(holdingSnapshots)).toHaveLength(0);
  });
});
