// @vitest-environment node
import { db } from "@/db/client.ts";
import { securities } from "@/db/schema/index.ts";
import type { SecurityFundamentals } from "@/lib/prices/yahoo-fundamentals.ts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshFundamentalsWeeklyProcessor } from "./refresh-fundamentals-weekly.ts";

/**
 * P9-07 — the weekly enrichment job refreshes only null/stale securities, stamps
 * the watermark, falls back to the Plaid `type` for asset_type when Yahoo gives
 * nothing, and is idempotent (a second immediate run touches nothing).
 */

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE securities CASCADE`);
}

const AAPL_DATA: SecurityFundamentals = {
  sector: "Technology",
  industry: "Consumer Electronics",
  region: "United States",
  assetType: "equity",
  expenseRatio: null,
  dividendRate: "0.96",
  dividendExDate: "2024-02-07",
};

describe("refreshFundamentalsWeekly (P9-07)", () => {
  beforeEach(reset);
  afterAll(reset);

  it("enriches stale rows, skips fresh ones, falls back for SEC:, and is idempotent", async () => {
    const [aapl] = await db
      .insert(securities)
      .values({ symbol: "AAPL", name: "Apple Inc.", type: "equity" }) // refreshed_at NULL → stale
      .returning({ id: securities.id });
    const [msft] = await db
      .insert(securities)
      .values({
        symbol: "MSFT",
        name: "Microsoft",
        type: "equity",
        fundamentalsRefreshedAt: new Date(), // fresh → skipped
      })
      .returning({ id: securities.id });
    const [synthetic] = await db
      .insert(securities)
      .values({ symbol: "SEC:x", name: "Proprietary Cash Fund", type: "cash" }) // stale, no Yahoo data
      .returning({ id: securities.id });
    if (!aapl || !msft || !synthetic) throw new Error("seed failed");

    const fetchFn = vi.fn(async (symbol: string) => (symbol === "AAPL" ? AAPL_DATA : null));

    await refreshFundamentalsWeeklyProcessor({} as never, { fetchFn });

    // Only the two stale rows were fetched (MSFT skipped).
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledWith("AAPL");
    expect(fetchFn).toHaveBeenCalledWith("SEC:x");
    expect(fetchFn).not.toHaveBeenCalledWith("MSFT");

    const [a] = await db.select().from(securities).where(eq(securities.id, aapl.id));
    expect(a?.sector).toBe("Technology");
    expect(a?.assetType).toBe("equity");
    expect(a?.dividendRate).toBe("0.96000000"); // numeric(18,8) round-trip
    expect(a?.fundamentalsRefreshedAt).not.toBeNull();

    // SEC: had no Yahoo data → asset_type falls back to the Plaid `type` ("cash").
    const [s] = await db.select().from(securities).where(eq(securities.id, synthetic.id));
    expect(s?.assetType).toBe("cash");
    expect(s?.sector).toBeNull();
    expect(s?.fundamentalsRefreshedAt).not.toBeNull();

    // MSFT untouched: still no sector.
    const [m] = await db.select().from(securities).where(eq(securities.id, msft.id));
    expect(m?.sector).toBeNull();

    // Idempotent: everything is now fresh, so a second run fetches nothing.
    const fetchFn2 = vi.fn(async () => null);
    await refreshFundamentalsWeeklyProcessor({} as never, { fetchFn: fetchFn2 });
    expect(fetchFn2).not.toHaveBeenCalled();
  });
});
