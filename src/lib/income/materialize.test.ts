// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  type MaterializeRule,
  type MaterializeSource,
  type PlanContributionsInput,
  type PlannedContribution,
  planContributions,
} from "./materialize.ts";

/** Index into a plan, failing loudly instead of asserting against `undefined`. */
function at(planned: readonly PlannedContribution[], index = 0): PlannedContribution {
  const item = planned[index];
  if (item === undefined) {
    throw new Error(`expected a planned contribution at index ${index}, got ${planned.length}`);
  }
  return item;
}

/** Narrow to the priceable arm so `close`/`quantity` are reachable. */
function priceable(contribution: PlannedContribution) {
  if (contribution.kind !== "priceable") {
    throw new Error(`expected a priceable contribution, got ${contribution.kind}`);
  }
  return contribution;
}

/** Narrow to the basis-only arm. */
function basisOnly(contribution: PlannedContribution) {
  if (contribution.kind !== "basis-only") {
    throw new Error(`expected a basis-only contribution, got ${contribution.kind}`);
  }
  return contribution;
}

function source(overrides: Partial<MaterializeSource> = {}): MaterializeSource {
  return {
    cadence: "biweekly",
    grossPerPeriod: "3000.00",
    currency: "USD",
    anchorDate: "2026-01-02",
    startDate: "2026-01-01",
    endDate: null,
    active: true,
    ...overrides,
  };
}

function rule(overrides: Partial<MaterializeRule> = {}): MaterializeRule {
  return {
    employeeBasis: "percent",
    employeeValue: "6",
    matchBasis: "percent_of_gross",
    matchValue: "3",
    matchCapPercent: null,
    active: true,
    symbol: "VTSAX",
    ...overrides,
  };
}

/** A lookup that returns the same close for every date. */
const flatPrice = (close: string | null) => (): string | null => close;

function plan(overrides: Partial<PlanContributionsInput> = {}) {
  return planContributions({
    rule: rule(),
    source: source(),
    window: { from: "2026-01-01", to: "2026-01-31" },
    existingPayDates: [],
    priceLookup: flatPrice("100.00"),
    ...overrides,
  });
}

describe("planContributions — priceable branch", () => {
  it("buys shares at the pay-date close", async () => {
    const planned = await plan({ window: { from: "2026-01-01", to: "2026-01-16" } });

    expect(planned).toHaveLength(2);
    const first = priceable(at(planned));
    expect(first.payDate).toBe("2026-01-02");
    expect(first.gross).toBe("3000.00");
    expect(first.employee).toBe("180.00"); // 6% of gross
    expect(first.employer).toBe("90.00"); // 3% of gross
    expect(first.total).toBe("270.00");
    expect(first.close).toBe("100");
    expect(first.quantity).toBe("2.7"); // 270 ÷ 100
  });

  it("computes fractional share counts at 8-decimal scale", async () => {
    const planned = await plan({
      window: { from: "2026-01-02", to: "2026-01-02" },
      priceLookup: flatPrice("437.19"),
    });
    // 270 ÷ 437.19 = 0.6175804...  → 8dp
    expect(priceable(at(planned)).quantity).toBe("0.61758046");
  });

  it("asks the lookup for the rule's symbol on each pay date", async () => {
    const lookup = vi.fn(() => "50.00");
    await plan({ window: { from: "2026-01-01", to: "2026-01-16" }, priceLookup: lookup });

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenNthCalledWith(1, "VTSAX", "2026-01-02");
    expect(lookup).toHaveBeenNthCalledWith(2, "VTSAX", "2026-01-16");
  });

  it("accepts an async lookup (the job's DB read)", async () => {
    const planned = await plan({
      window: { from: "2026-01-02", to: "2026-01-02" },
      priceLookup: async () => "100.00",
    });
    expect(at(planned).kind).toBe("priceable");
  });
});

describe("planContributions — basis-only branch", () => {
  it("records dollars only when the rule designates no symbol", async () => {
    const planned = await plan({
      rule: rule({ symbol: null }),
      window: { from: "2026-01-02", to: "2026-01-02" },
    });

    expect(planned).toHaveLength(1);
    const only = basisOnly(at(planned));
    expect(only.total).toBe("270.00");
    expect(only.symbol).toBeNull();
    // No invented share count — the whole point of ADR-031's fallback.
    expect(only).not.toHaveProperty("quantity");
  });

  it("falls back to basis-only when no price exists for the pay date", async () => {
    const planned = await plan({
      window: { from: "2026-01-02", to: "2026-01-02" },
      priceLookup: flatPrice(null),
    });
    // The symbol is retained so the UI can explain WHY it degraded.
    expect(basisOnly(at(planned)).symbol).toBe("VTSAX");
  });

  it("falls back to basis-only for a zero, negative, or unparseable close", async () => {
    for (const close of ["0", "0.00", "-12.00", "not-a-price", "NaN"]) {
      const planned = await plan({
        window: { from: "2026-01-02", to: "2026-01-02" },
        priceLookup: flatPrice(close),
      });
      expect(at(planned).kind, `close=${close}`).toBe("basis-only");
    }
  });

  it("degrades per pay date, not per rule", async () => {
    // Backfills straddle the start of price history: early dates are basis-only,
    // later ones buy shares.
    const planned = await plan({
      window: { from: "2026-01-01", to: "2026-01-31" },
      priceLookup: (_symbol: string, date: string) => (date >= "2026-01-16" ? "100.00" : null),
    });
    expect(planned.map((p) => `${p.payDate}:${p.kind}`)).toEqual([
      "2026-01-02:basis-only",
      "2026-01-16:priceable",
      "2026-01-30:priceable",
    ]);
  });
});

describe("planContributions — idempotency and windowing", () => {
  it("skips pay dates already in the ledger", async () => {
    const planned = await plan({
      window: { from: "2026-01-01", to: "2026-01-31" },
      existingPayDates: ["2026-01-02", "2026-01-16"],
    });
    expect(planned.map((p) => p.payDate)).toEqual(["2026-01-30"]);
  });

  it("plans nothing when every pay date is already materialized", async () => {
    const planned = await plan({
      window: { from: "2026-01-01", to: "2026-01-31" },
      existingPayDates: ["2026-01-02", "2026-01-16", "2026-01-30"],
    });
    expect(planned).toEqual([]);
  });

  it("never materializes before the source's start date", async () => {
    const planned = await plan({
      source: source({ startDate: "2026-01-16" }),
      window: { from: "2025-01-01", to: "2026-01-31" },
    });
    expect(planned.map((p) => p.payDate)).toEqual(["2026-01-16", "2026-01-30"]);
  });

  it("stops at the source's end date", async () => {
    const planned = await plan({
      source: source({ endDate: "2026-01-16" }),
      window: { from: "2026-01-01", to: "2026-12-31" },
    });
    expect(planned.map((p) => p.payDate)).toEqual(["2026-01-02", "2026-01-16"]);
  });

  it("returns nothing when the window falls outside the source's life", async () => {
    expect(
      await plan({
        source: source({ startDate: "2026-06-01" }),
        window: { from: "2026-01-01", to: "2026-05-31" },
      }),
    ).toEqual([]);
  });

  it("backfills years of history in one pass", async () => {
    const planned = await plan({
      source: source({ startDate: "2024-01-05", anchorDate: "2024-01-05" }),
      window: { from: "2024-01-01", to: "2026-01-01" },
    });
    // 2024-01-05 → 2025-12-19 inclusive, every 14 days.
    expect(planned).toHaveLength(52);
    expect(at(planned).payDate).toBe("2024-01-05");
    expect(planned.at(-1)?.payDate).toBe("2025-12-19");
  });
});

describe("planContributions — inactive and no-op rules", () => {
  it("plans nothing for an inactive rule", async () => {
    expect(await plan({ rule: rule({ active: false }) })).toEqual([]);
  });

  it("plans nothing for an inactive source", async () => {
    expect(await plan({ source: source({ active: false }) })).toEqual([]);
  });

  it("plans nothing when the rule contributes zero dollars", async () => {
    const planned = await plan({
      rule: rule({ employeeValue: "0", matchBasis: "none", matchValue: "0" }),
    });
    expect(planned).toEqual([]);
  });

  it("still plans an employer-only contribution", async () => {
    const planned = await plan({
      rule: rule({ employeeValue: "0", matchBasis: "amount", matchValue: "100" }),
      window: { from: "2026-01-02", to: "2026-01-02" },
    });
    expect(planned).toHaveLength(1);
    expect(at(planned).employee).toBe("0.00");
    expect(at(planned).employer).toBe("100.00");
  });

  it("does not call the price lookup when there is nothing to plan", async () => {
    const lookup = vi.fn(() => "100.00");
    await plan({ rule: rule({ active: false }), priceLookup: lookup });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("plans a paused rule and source when includeInactive is set", async () => {
    // `active` gates the FUTURE; it is not a claim the past didn't happen. The
    // backfill sets this so a retired paycheck's history can be reconstructed.
    const planned = await plan({
      rule: rule({ active: false }),
      source: source({ active: false }),
      includeInactive: true,
    });
    expect(planned.length).toBeGreaterThan(0);
  });

  it("still honours end_date when includeInactive is set", async () => {
    // Including paused sources must not let a finished paycheck materialize
    // into the present — `end_date`, not `active`, is what bounds it.
    const planned = await plan({
      rule: rule({ active: false }),
      source: source({ active: false, endDate: "2026-01-02" }),
      includeInactive: true,
    });
    expect(planned.map((p) => p.payDate)).toEqual(["2026-01-02"]);
  });
});
