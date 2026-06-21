// @vitest-environment node
import { randomUUID } from "node:crypto";
import { db } from "@/db/client.ts";
import { prices, watchlistItems } from "@/db/schema/index.ts";
import type { DailyClose } from "@/lib/prices/types.ts";
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { backfillWatchlistSymbolProcessor } from "./backfill-watchlist-symbol.ts";

/**
 * Integration test for the watchlist history backfill (P11-08). Uses a mock
 * series fetcher so the suite stays offline; the real fetchers have their own
 * unit tests.
 */
async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE watchlist_items, prices CASCADE`);
}

const job = (watchlistItemId: string) =>
  ({ id: "test", data: { watchlistItemId } }) as unknown as Job<{ watchlistItemId: string }>;

async function seedItem(over: Partial<typeof watchlistItems.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(watchlistItems)
    .values({ symbol: "AAPL", assetClass: "equity", ...over })
    .returning({ id: watchlistItems.id });
  if (!row) throw new Error("seed failed");
  return row.id;
}

const series: DailyClose[] = [
  { date: "2026-01-01", close: "100.00000000" },
  { date: "2026-01-02", close: "101.50000000" },
];

describe("backfillWatchlistSymbolProcessor", () => {
  beforeEach(reset);
  afterAll(reset);

  it("writes one price row per returned day and is idempotent on re-run", async () => {
    const id = await seedItem();
    const fetchSeries = async () => series;

    const first = await backfillWatchlistSymbolProcessor(job(id), { fetchSeries });
    expect(first.written).toBe(2);

    const rows = await db.select().from(prices).where(eq(prices.symbol, "AAPL"));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source)).toEqual(["yahoo", "yahoo"]);

    // Re-run overwrites the same (symbol, date) PKs — no new rows.
    const second = await backfillWatchlistSymbolProcessor(job(id), { fetchSeries });
    expect(second.written).toBe(2);
    expect(await db.$count(prices)).toBe(2);
  });

  it("starts the window at pretend_purchased_at when present", async () => {
    const id = await seedItem({
      pretendQuantity: "5",
      pretendUnitCost: "90.00",
      pretendPurchasedAt: "2025-03-15",
    });
    let observedFrom = "";
    await backfillWatchlistSymbolProcessor(job(id), {
      fetchSeries: async (_class, _symbol, fromIso) => {
        observedFrom = fromIso;
        return series;
      },
    });
    expect(observedFrom).toBe("2025-03-15");
  });

  it("tags crypto rows with the coingecko source", async () => {
    const id = await seedItem({ symbol: "BTC", assetClass: "crypto" });
    await backfillWatchlistSymbolProcessor(job(id), {
      fetchSeries: async () => [{ date: "2026-01-01", close: "65000.00000000" }],
    });
    const [row] = await db.select().from(prices).where(eq(prices.symbol, "BTC"));
    expect(row?.source).toBe("coingecko");
  });

  it("returns {written:0} without throwing when the fetch fails", async () => {
    const id = await seedItem();
    const result = await backfillWatchlistSymbolProcessor(job(id), {
      fetchSeries: async () => {
        throw new Error("upstream 500");
      },
    });
    expect(result).toEqual({ written: 0 });
    expect(await db.$count(prices)).toBe(0);
  });

  it("returns {written:0} when the watch row no longer exists", async () => {
    const result = await backfillWatchlistSymbolProcessor(job(randomUUID()), {
      fetchSeries: async () => series,
    });
    expect(result).toEqual({ written: 0 });
  });
});
