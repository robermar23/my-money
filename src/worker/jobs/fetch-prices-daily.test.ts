import { db } from "@/db/client.ts";
import { accounts, holdings, prices } from "@/db/schema/index.ts";
import type { PriceFetcher, PriceQuote } from "@/lib/prices/types.ts";
import type { Job } from "bullmq";
import { sql } from "drizzle-orm";
// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fetchPricesDailyProcessor } from "./fetch-prices-daily.ts";

/**
 * Integration test for the price-fetch orchestrator. Uses mock fetchers so the
 * suite stays offline — the real fetchers have their own unit tests.
 */

function makeFetcher(source: string, returns: Record<string, string>): PriceFetcher {
  return {
    source,
    quote: async (symbol: string): Promise<PriceQuote> => {
      const close = returns[symbol.toUpperCase()];
      if (!close) throw new Error(`mock: no price for ${symbol}`);
      return {
        symbol: symbol.toUpperCase(),
        date: new Date().toISOString().slice(0, 10),
        close,
        source,
      };
    },
  };
}

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE accounts, holdings, prices CASCADE`);
}

const fakeJob = { id: "test" } as unknown as Job;

describe("fetchPricesDailyProcessor", () => {
  beforeEach(reset);
  afterAll(reset);

  it("fetches only the benchmark when no holdings exist", async () => {
    // The S&P 500 benchmark (^GSPC) is always fetched for the performance page
    // (P9-12), even with no holdings.
    const result = await fetchPricesDailyProcessor(fakeJob, {
      equity: makeFetcher("yahoo", { "^GSPC": "5000.00000000" }),
      crypto: makeFetcher("coingecko", {}),
      physicalMetal: makeFetcher("alpha_vantage", {}),
    });
    expect(result).toEqual({ succeeded: 1, failed: 0, errors: [] });
  });

  it("fetches each distinct held symbol via the correct fetcher and upserts", async () => {
    const [acc] = await db
      .insert(accounts)
      .values({ name: "Brokerage", institution: "Fidelity", type: "investment" })
      .returning({ id: accounts.id });
    if (!acc) throw new Error("seed failed");
    await db.insert(holdings).values([
      {
        accountId: acc.id,
        symbol: "AAPL",
        quantity: "10",
        quantityUnit: "shares",
        assetClass: "equity",
      },
      {
        accountId: acc.id,
        symbol: "BTC",
        quantity: "0.5",
        quantityUnit: "coin",
        assetClass: "crypto",
      },
      {
        accountId: acc.id,
        symbol: "XAU",
        quantity: "5",
        quantityUnit: "troy_oz",
        assetClass: "physical_metal",
      },
    ]);

    const result = await fetchPricesDailyProcessor(fakeJob, {
      equity: makeFetcher("yahoo", { AAPL: "234.56000000", "^GSPC": "5000.00000000" }),
      crypto: makeFetcher("coingecko", { BTC: "65000.00000000" }),
      physicalMetal: makeFetcher("alpha_vantage", { XAU: "2350.45000000" }),
    });
    expect(result.succeeded).toBe(4); // AAPL + BTC + XAU + the ^GSPC benchmark
    expect(result.failed).toBe(0);

    const rows = await db.select().from(prices);
    const bySymbol = Object.fromEntries(rows.map((r) => [r.symbol, r]));
    expect(bySymbol.AAPL?.source).toBe("yahoo");
    expect(bySymbol.BTC?.source).toBe("coingecko");
    expect(bySymbol.XAU?.source).toBe("alpha_vantage");
    expect(bySymbol["^GSPC"]?.source).toBe("yahoo");
  });

  it("isolates per-symbol failures — one bad source doesn't kill the others", async () => {
    const [acc] = await db
      .insert(accounts)
      .values({ name: "X", institution: "Y", type: "investment" })
      .returning({ id: accounts.id });
    if (!acc) throw new Error("seed failed");
    await db.insert(holdings).values([
      {
        accountId: acc.id,
        symbol: "AAPL",
        quantity: "1",
        quantityUnit: "shares",
        assetClass: "equity",
      },
      {
        accountId: acc.id,
        symbol: "BTC",
        quantity: "1",
        quantityUnit: "coin",
        assetClass: "crypto",
      },
    ]);

    const result = await fetchPricesDailyProcessor(fakeJob, {
      equity: makeFetcher("yahoo", { AAPL: "100", "^GSPC": "5000" }),
      crypto: makeFetcher("coingecko", {}), // BTC will fail (no mock entry)
      physicalMetal: makeFetcher("alpha_vantage", {}),
    });
    expect(result.succeeded).toBe(2); // AAPL + ^GSPC
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.symbol).toBe("BTC");
  });

  it("skips holdings whose asset_class doesn't need fetching (cash, property)", async () => {
    const [propAcc] = await db
      .insert(accounts)
      .values({ name: "Home", institution: "—", type: "property" })
      .returning({ id: accounts.id });
    if (!propAcc) throw new Error("seed failed");
    await db.insert(holdings).values({
      accountId: propAcc.id,
      symbol: "HOME",
      quantity: "450000",
      quantityUnit: "usd",
      assetClass: "property",
    });

    const result = await fetchPricesDailyProcessor(fakeJob, {
      equity: makeFetcher("yahoo", { "^GSPC": "5000.00000000" }),
      crypto: makeFetcher("coingecko", {}),
      physicalMetal: makeFetcher("alpha_vantage", {}),
    });
    // Only the always-on benchmark fetches; the property holding is skipped.
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("re-running on the same day overwrites yesterday's price for the same symbol", async () => {
    const [acc] = await db
      .insert(accounts)
      .values({ name: "X", institution: "Y", type: "investment" })
      .returning({ id: accounts.id });
    if (!acc) throw new Error("seed failed");
    await db.insert(holdings).values({
      accountId: acc.id,
      symbol: "AAPL",
      quantity: "1",
      quantityUnit: "shares",
      assetClass: "equity",
    });

    await fetchPricesDailyProcessor(fakeJob, {
      equity: makeFetcher("yahoo", { AAPL: "100" }),
      crypto: makeFetcher("coingecko", {}),
      physicalMetal: makeFetcher("alpha_vantage", {}),
    });
    await fetchPricesDailyProcessor(fakeJob, {
      equity: makeFetcher("yahoo", { AAPL: "150" }),
      crypto: makeFetcher("coingecko", {}),
      physicalMetal: makeFetcher("alpha_vantage", {}),
    });

    const rows = await db.select().from(prices);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.close).toBe("150.00000000");
  });
});
