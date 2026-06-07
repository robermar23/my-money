import { db } from "@/db/client.ts";
import { accounts, holdings, prices } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { distinctHeldSymbols, latestCloseOnOrBefore, upsertPrice } from "./store.ts";

async function resetTables(): Promise<void> {
  await db.execute(sql`TRUNCATE accounts, holdings, prices CASCADE`);
}

describe("prices store", () => {
  beforeEach(resetTables);
  afterAll(resetTables);

  describe("upsertPrice", () => {
    it("inserts a new row", async () => {
      await upsertPrice({
        symbol: "AAPL",
        date: "2026-05-25",
        close: "234.56000000",
        source: "yahoo",
      });
      const rows = await db.select().from(prices);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.close).toBe("234.56000000");
    });

    it("overwrites on conflict (symbol+date)", async () => {
      await upsertPrice({ symbol: "AAPL", date: "2026-05-25", close: "100", source: "yahoo" });
      await upsertPrice({ symbol: "AAPL", date: "2026-05-25", close: "200", source: "yahoo" });
      const rows = await db.select().from(prices);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.close).toBe("200.00000000");
    });
  });

  describe("distinctHeldSymbols", () => {
    it("returns empty when no holdings", async () => {
      expect(await distinctHeldSymbols()).toEqual([]);
    });

    it("dedupes across accounts", async () => {
      const [a1, a2] = await db
        .insert(accounts)
        .values([
          { name: "B1", institution: "X", type: "investment" },
          { name: "B2", institution: "Y", type: "investment" },
        ])
        .returning({ id: accounts.id });
      if (!a1 || !a2) throw new Error("seed failed");
      await db.insert(holdings).values([
        {
          accountId: a1.id,
          symbol: "AAPL",
          quantity: "10",
          quantityUnit: "shares",
          assetClass: "equity",
        },
        {
          accountId: a2.id,
          symbol: "AAPL",
          quantity: "5",
          quantityUnit: "shares",
          assetClass: "equity",
        },
        {
          accountId: a1.id,
          symbol: "BTC",
          quantity: "0.5",
          quantityUnit: "coin",
          assetClass: "crypto",
        },
      ]);
      const held = await distinctHeldSymbols();
      held.sort((a, b) => a.symbol.localeCompare(b.symbol));
      expect(held).toEqual([
        { symbol: "AAPL", assetClass: "equity" },
        { symbol: "BTC", assetClass: "crypto" },
      ]);
    });

    it("excludes synthetic SEC: symbols (priced from Plaid's institution_price, not Yahoo)", async () => {
      const [a1] = await db
        .insert(accounts)
        .values({ name: "B1", institution: "Fidelity", type: "investment" })
        .returning({ id: accounts.id });
      if (!a1) throw new Error("seed failed");
      await db.insert(holdings).values([
        {
          accountId: a1.id,
          symbol: "AAPL",
          quantity: "10",
          quantityUnit: "shares",
          assetClass: "equity",
        },
        {
          accountId: a1.id,
          symbol: "SEC:plaid-proprietary-fund",
          quantity: "100",
          quantityUnit: "shares",
          assetClass: "equity",
        },
      ]);
      const held = await distinctHeldSymbols();
      expect(held).toEqual([{ symbol: "AAPL", assetClass: "equity" }]);
    });
  });

  describe("latestCloseOnOrBefore", () => {
    it("returns null when no price exists", async () => {
      expect(await latestCloseOnOrBefore("AAPL", "2026-05-25")).toBeNull();
    });

    it("returns the most-recent price <= asOf", async () => {
      await db.insert(prices).values([
        { symbol: "AAPL", date: "2026-05-01", close: "100" },
        { symbol: "AAPL", date: "2026-05-10", close: "120" },
        { symbol: "AAPL", date: "2026-05-25", close: "150" },
      ]);
      expect(await latestCloseOnOrBefore("AAPL", "2026-05-15")).toBe("120.00000000");
      expect(await latestCloseOnOrBefore("AAPL", "2026-05-25")).toBe("150.00000000");
      expect(await latestCloseOnOrBefore("AAPL", "2026-04-01")).toBeNull();
    });
  });
});
