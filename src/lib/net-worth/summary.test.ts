// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import { summarySentence } from "./summary.ts";
import type { AttributionResult, AttributionRung, AttributionRungId } from "./types.ts";
import { ATTRIBUTION_RUNG_IDS } from "./types.ts";

/**
 * P17-15 — the summary sentence.
 *
 * The function's whole job is deciding what to leave out, so the assertions are
 * about *which rungs are named*, not about wording. The case that matters most
 * is the last one: a window whose residual dominates must say so rather than
 * confidently attributing the change to a rung.
 */

const CURRENCY = "USD";

const LABELS: Readonly<Record<AttributionRungId, string>> = {
  saved: "Saved from income",
  retirement: "Retirement contributions",
  debt_principal: "Loan principal paid",
  investment_return: "Investment return",
  asset_revaluation: "Property & asset revaluation",
  unexplained: "Not yet explained",
};

/** A result from just the rung amounts. Everything else defaults to a clean book. */
function result(
  amounts: Partial<Record<AttributionRungId, string>>,
  overrides: Partial<AttributionResult> = {},
): AttributionResult {
  const rungs: AttributionRung[] = ATTRIBUTION_RUNG_IDS.map((id) => ({
    id,
    label: LABELS[id],
    amount: amounts[id] ?? "0.00",
    inputsUsed: [],
  }));
  // Money, not `Number`, even in a fixture: the assertions below are exact
  // string comparisons, and a float-built delta would make them pass or fail
  // for a reason that has nothing to do with the module under test.
  const opening = Money.fromString("100000.00", CURRENCY);
  const delta = Money.sum(
    rungs.map((r) => Money.fromString(r.amount, CURRENCY)),
    CURRENCY,
  );

  return {
    from: "2026-01-01",
    to: "2026-03-31",
    opening: opening.toString(),
    closing: opening.add(delta).toString(),
    delta: delta.toString(),
    rungs,
    diagnostics: [],
    status: "ok",
    inputsUsed: [],
    ...overrides,
  };
}

function named(summary: ReturnType<typeof summarySentence>): AttributionRungId[] {
  return summary.drivers.map((d) => d.rungId);
}

describe("a market-driven gain", () => {
  const summary = summarySentence(
    result({ saved: "1200.00", investment_return: "18000.00", retirement: "600.00" }),
  );

  it("reads as a rise", () => {
    expect(summary.direction).toBe("up");
    expect(summary.delta).toBe("19800.00");
    expect(summary.magnitude).toBe("19800.00");
  });

  it("names the market first and drops the immaterial rung", () => {
    // $600 is 3% of the change — true, and not worth a clause.
    expect(named(summary)).toEqual(["investment_return", "saved"]);
  });

  it("says nothing about a residual there is none of", () => {
    expect(summary.residual).toBeNull();
    expect(summary.residualDominant).toBe(false);
  });
});

describe("a savings-driven gain", () => {
  it("names what the household did, in size order", () => {
    const summary = summarySentence(
      result({ saved: "9000.00", debt_principal: "2600.00", investment_return: "400.00" }),
    );
    expect(named(summary)).toEqual(["saved", "debt_principal"]);
    expect(summary.drivers[0]?.label).toBe("Saved from income");
    expect(summary.drivers.every((d) => d.direction === "up")).toBe(true);
  });
});

describe("a decline", () => {
  const summary = summarySentence(
    result({ saved: "-3000.00", investment_return: "-12000.00", asset_revaluation: "-5000.00" }),
  );

  it("reads as a fall and reports the magnitude without a sign", () => {
    expect(summary.direction).toBe("down");
    expect(summary.delta).toBe("-20000.00");
    expect(summary.magnitude).toBe("20000.00");
  });

  it("names every driver that pushed it down", () => {
    expect(named(summary)).toEqual(["investment_return", "asset_revaluation", "saved"]);
    expect(summary.drivers.every((d) => d.direction === "down")).toBe(true);
  });
});

describe("a window where the residual dominates", () => {
  const summary = summarySentence(
    result(
      { saved: "2000.00", unexplained: "9000.00" },
      { diagnostics: [{ code: "uncategorized", label: "x", detail: "y", magnitude: "9000.00" }] },
    ),
  );

  it("states the residual rather than burying it", () => {
    expect(summary.residual?.rungId).toBe("unexplained");
    expect(summary.residual?.amount).toBe("9000.00");
    expect(summary.residualDominant).toBe(true);
  });

  it("keeps `unexplained` out of the drivers — it is not an explanation", () => {
    expect(named(summary)).toEqual(["saved"]);
  });

  it("carries the count of causes so the copy can promise them", () => {
    expect(summary.diagnosticCount).toBe(1);
  });
});

describe("thresholds", () => {
  it("states a residual at the stated share, and not below it", () => {
    // 10% of a $10,000 change.
    const at = summarySentence(result({ saved: "9000.00", unexplained: "1000.00" }));
    expect(at.residual).not.toBeNull();
    expect(at.residualDominant).toBe(false);

    // Deliberately BETWEEN the two shares: 7% of the change clears the
    // material floor a rung would use and still fails the residual's own.
    const below = summarySentence(result({ saved: "9300.00", unexplained: "700.00" }));
    expect(below.residual).toBeNull();
  });

  it("names a rung at the stated share, and not below it", () => {
    const at = summarySentence(result({ saved: "9500.00", retirement: "500.00" }));
    expect(named(at)).toEqual(["saved", "retirement"]);

    const below = summarySentence(result({ saved: "9900.00", retirement: "100.00" }));
    expect(named(below)).toEqual(["saved"]);
  });
});

describe("a flat window", () => {
  it("names every nonzero rung when the change is exactly zero", () => {
    // A quarter where a market fall cancels what the household saved is real
    // and interesting; dividing by its delta would throw on the one book that
    // most deserves a sentence.
    const summary = summarySentence(result({ saved: "5000.00", investment_return: "-5000.00" }));
    expect(summary.direction).toBe("flat");
    expect(summary.delta).toBe("0.00");
    expect(named(summary)).toEqual(["saved", "investment_return"]);
  });

  it("states a residual that exists even though nothing moved", () => {
    const summary = summarySentence(result({ saved: "800.00", unexplained: "-800.00" }));
    expect(summary.direction).toBe("flat");
    expect(summary.residual?.amount).toBe("-800.00");
    expect(summary.residualDominant).toBe(true);
  });

  it("names nothing at all on an empty book", () => {
    const summary = summarySentence(result({}));
    expect(summary.drivers).toEqual([]);
    expect(summary.residual).toBeNull();
    expect(summary.residualDominant).toBe(false);
  });
});

describe("carrying the surface's other decisions", () => {
  it("passes the window and the status straight through", () => {
    const summary = summarySentence(result({}, { status: "insufficient_history" }));
    expect(summary.from).toBe("2026-01-01");
    expect(summary.to).toBe("2026-03-31");
    expect(summary.status).toBe("insufficient_history");
  });

  it("breaks a tie on narrative order, not array luck", () => {
    const summary = summarySentence(result({ investment_return: "5000.00", saved: "5000.00" }));
    // Equal magnitudes: `saved` comes first because the rung order does and
    // the sort is stable. Stated as a test because the module deliberately
    // carries no tie-break branch of its own.
    expect(named(summary)).toEqual(["saved", "investment_return"]);
  });
});
