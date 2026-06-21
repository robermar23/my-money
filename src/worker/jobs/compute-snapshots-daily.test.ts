// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  holdingSnapshots,
  holdings,
  prices,
} from "@/db/schema/index.ts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { computeSnapshotsDailyProcessor } from "./compute-snapshots-daily.ts";

/**
 * P9-02 — the nightly snapshot job also emits per-holding `holding_snapshots`
 * rows in the same valuation pass. These tests pin: (1) a priced position gets
 * a correct, idempotent snapshot; (2) the account snapshot is unaffected (no
 * regression); (3) an unpriced security is skipped rather than recorded at a
 * misleading $0.
 */

const TODAY = new Date().toISOString().slice(0, 10);

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE holding_snapshots, holding_lots, holdings, account_snapshots, accounts, prices CASCADE`,
  );
}

async function seedInvestmentAccount(): Promise<string> {
  const [a] = await db
    .insert(accounts)
    .values({ name: "Brokerage", institution: "Fidelity", type: "investment", currency: "USD" })
    .returning({ id: accounts.id });
  if (!a) throw new Error("seed account failed");
  return a.id;
}

describe("computeSnapshotsDaily — holding_snapshots (P9-02)", () => {
  beforeEach(reset);
  afterAll(reset);

  it("writes a correct per-holding snapshot for a priced position, idempotently", async () => {
    const accountId = await seedInvestmentAccount();
    const [h] = await db
      .insert(holdings)
      .values({
        accountId,
        symbol: "AAPL",
        quantity: "10",
        quantityUnit: "shares",
        assetClass: "equity",
        costBasis: "1000.00",
      })
      .returning({ id: holdings.id });
    if (!h) throw new Error("seed holding failed");
    await db.insert(prices).values({ symbol: "AAPL", date: TODAY, close: "150" });

    await computeSnapshotsDailyProcessor({} as never);

    const snaps = await db
      .select()
      .from(holdingSnapshots)
      .where(eq(holdingSnapshots.holdingId, h.id));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.date).toBe(TODAY);
    expect(snaps[0]?.value).toBe("1500.00"); // 10 × 150
    expect(snaps[0]?.quantity).toBe("10.00000000");
    expect(snaps[0]?.costBasis).toBe("1000.00");
    expect(snaps[0]?.currency).toBe("USD");

    // Account-level snapshot still written with the same total — no regression.
    const acct = await db
      .select()
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, accountId));
    expect(acct).toHaveLength(1);
    expect(acct[0]?.balance).toBe("1500.00");

    // Re-running the same day updates in place, never duplicates.
    await computeSnapshotsDailyProcessor({} as never);
    const after = await db
      .select()
      .from(holdingSnapshots)
      .where(eq(holdingSnapshots.holdingId, h.id));
    expect(after).toHaveLength(1);
  });

  it("skips an unpriced security rather than recording a $0 history row", async () => {
    const accountId = await seedInvestmentAccount();
    // A priced position keeps the account total non-zero so the job takes the
    // holdings-valuation path (not the carry-forward fallback).
    await db.insert(holdings).values({
      accountId,
      symbol: "AAPL",
      quantity: "10",
      quantityUnit: "shares",
      assetClass: "equity",
    });
    const [noPrice] = await db
      .insert(holdings)
      .values({
        accountId,
        symbol: "ZZZZ",
        quantity: "5",
        quantityUnit: "shares",
        assetClass: "equity",
      })
      .returning({ id: holdings.id });
    if (!noPrice) throw new Error("seed holding failed");
    await db.insert(prices).values({ symbol: "AAPL", date: TODAY, close: "100" });

    await computeSnapshotsDailyProcessor({} as never);

    const snaps = await db
      .select()
      .from(holdingSnapshots)
      .where(eq(holdingSnapshots.holdingId, noPrice.id));
    expect(snaps).toHaveLength(0);
  });
});
