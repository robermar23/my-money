import { describe, expect, it } from "vitest";
import {
  type BuyTxnInput,
  aggregateLots,
  lotCoverage,
  lotFromBuy,
  resolveCostBasis,
} from "./lots.ts";

const lot = (quantity: string, costBasisTotal: string) => ({ quantity, costBasisTotal });

describe("aggregateLots", () => {
  it("sums lot quantities and cost bases", () => {
    const r = aggregateLots([lot("1.5", "1000.00"), lot("2.5", "500.00")], "USD");
    expect(r.totalQuantity).toBe("4");
    expect(r.totalCostBasis.toString()).toBe("1500.00");
  });

  it("sums fractional quantities without float drift", () => {
    const r = aggregateLots([lot("0.1", "1.00"), lot("0.2", "2.00")], "USD");
    expect(r.totalQuantity).toBe("0.3");
    expect(r.totalCostBasis.toString()).toBe("3.00");
  });

  it("returns zero for no lots", () => {
    const r = aggregateLots([], "USD");
    expect(r.totalQuantity).toBe("0");
    expect(r.totalCostBasis.toString()).toBe("0.00");
  });
});

describe("resolveCostBasis", () => {
  it("prefers the sum of lots over the aggregate column", () => {
    const r = resolveCostBasis(
      { costBasis: "999.00" },
      [lot("1", "1000.00"), lot("1", "500.00")],
      "USD",
    );
    expect(r?.toString()).toBe("1500.00");
  });

  it("falls back to the aggregate cost_basis when no lots exist", () => {
    const r = resolveCostBasis({ costBasis: "250.00" }, [], "USD");
    expect(r?.toString()).toBe("250.00");
  });

  it("returns null when there are neither lots nor an aggregate basis", () => {
    const r = resolveCostBasis({ costBasis: null }, [], "USD");
    expect(r).toBeNull();
  });
});

describe("lotCoverage", () => {
  it("reports complete coverage when lots sum to the holding quantity", () => {
    const r = lotCoverage({ quantity: "4" }, [lot("1.5", "0"), lot("2.5", "0")]);
    expect(r.coveredQty).toBe("4");
    expect(r.holdingQty).toBe("4");
    expect(r.isComplete).toBe(true);
  });

  it("reports incomplete coverage when lots cover only part of the position", () => {
    const r = lotCoverage({ quantity: "10" }, [lot("4", "0")]);
    expect(r.coveredQty).toBe("4");
    expect(r.holdingQty).toBe("10");
    expect(r.isComplete).toBe(false);
  });

  it("treats no lots as zero coverage", () => {
    const r = lotCoverage({ quantity: "10" }, []);
    expect(r.coveredQty).toBe("0");
    expect(r.isComplete).toBe(false);
  });
});

describe("lotFromBuy", () => {
  const buy = (over: Partial<BuyTxnInput> = {}): BuyTxnInput => ({
    type: "buy",
    quantity: "10",
    amount: "-1000.00", // our convention: cash outflow is negative
    tradeDate: "2026-05-15",
    plaidInvestmentTransactionId: "it-buy",
    isoCurrencyCode: "USD",
    ...over,
  });

  it("builds a lot from a buy, using |amount| as the cost basis", () => {
    const lot = lotFromBuy(buy(), "holding-1");
    expect(lot).not.toBeNull();
    expect(lot?.holdingId).toBe("holding-1");
    expect(lot?.quantity).toBe("10");
    expect(lot?.costBasisTotal).toBe("1000.00");
    expect(lot?.acquiredAt).toBe("2026-05-15");
    expect(lot?.source).toBe("plaid");
    expect(lot?.plaidInvestmentTransactionId).toBe("it-buy");
  });

  it("returns null for non-buy transactions", () => {
    expect(lotFromBuy(buy({ type: "sell" }), "h")).toBeNull();
    expect(lotFromBuy(buy({ type: "cash" }), "h")).toBeNull();
    expect(lotFromBuy(buy({ type: "fee" }), "h")).toBeNull();
  });

  it("returns null when the buy has no usable quantity", () => {
    expect(lotFromBuy(buy({ quantity: null }), "h")).toBeNull();
    expect(lotFromBuy(buy({ quantity: "0" }), "h")).toBeNull();
  });
});
