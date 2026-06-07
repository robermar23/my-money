// @vitest-environment node
import { db } from "@/db/client.ts";
import { securities } from "@/db/schema/index.ts";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type PlaidSecurityLike,
  mapSecurity,
  resolveSymbol,
  upsertSecurity,
} from "./securities.ts";

const security = (over: Partial<PlaidSecurityLike> = {}): PlaidSecurityLike => ({
  security_id: "sec-1",
  ticker_symbol: null,
  cusip: null,
  name: "Test Security",
  type: "equity",
  is_cash_equivalent: false,
  iso_currency_code: "USD",
  ...over,
});

describe("resolveSymbol", () => {
  it("prefers the ticker symbol", () => {
    expect(resolveSymbol(security({ ticker_symbol: "AAPL", cusip: "037833100" }))).toBe("AAPL");
  });

  it("falls back to the cusip when there is no ticker", () => {
    expect(resolveSymbol(security({ ticker_symbol: null, cusip: "037833100" }))).toBe("037833100");
  });

  it("falls back to a synthetic SEC:<id> when neither ticker nor cusip exists", () => {
    expect(
      resolveSymbol(security({ ticker_symbol: null, cusip: null, security_id: "sec-xyz" })),
    ).toBe("SEC:sec-xyz");
  });
});

describe("mapSecurity", () => {
  it("maps fields and resolves the canonical symbol", () => {
    const row = mapSecurity(
      security({ ticker_symbol: "VTI", name: "Vanguard Total", type: "etf" }),
    );
    expect(row.symbol).toBe("VTI");
    expect(row.tickerSymbol).toBe("VTI");
    expect(row.name).toBe("Vanguard Total");
    expect(row.type).toBe("etf");
    expect(row.plaidSecurityId).toBe("sec-1");
    expect(row.isCashEquivalent).toBe(false);
    expect(row.isoCurrencyCode).toBe("USD");
  });

  it("falls back the name to the resolved symbol when Plaid's name is null", () => {
    const row = mapSecurity(security({ name: null, ticker_symbol: "TSLA" }));
    expect(row.name).toBe("TSLA");
  });

  it("defaults currency to USD and coerces null is_cash_equivalent to false", () => {
    const row = mapSecurity(security({ iso_currency_code: null, is_cash_equivalent: null }));
    expect(row.isoCurrencyCode).toBe("USD");
    expect(row.isCashEquivalent).toBe(false);
  });
});

describe("upsertSecurity", () => {
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE securities CASCADE`);
  });

  it("inserts on first call and updates the same row on the second (idempotent)", async () => {
    const first = await upsertSecurity(
      security({ security_id: "sec-up", ticker_symbol: "MSFT", name: "Microsoft" }),
    );
    expect(first.symbol).toBe("MSFT");

    const second = await upsertSecurity(
      security({ security_id: "sec-up", ticker_symbol: "MSFT", name: "Microsoft Corp" }),
    );
    expect(second.id).toBe(first.id);

    const rows = await db.select().from(securities).where(eq(securities.plaidSecurityId, "sec-up"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Microsoft Corp");
  });
});
