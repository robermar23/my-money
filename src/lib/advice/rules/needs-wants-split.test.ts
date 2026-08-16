// @vitest-environment node
import { describe, expect, it } from "vitest";
import { makeAdviceInput, makeEssentialMonths, makeProfile } from "../advice-input.fixture.ts";
import { needsWantsSplitRule, splitDiagnostic } from "./needs-wants-split.ts";

/*
 * P15-26 — the 50/30/20 diagnostic. Pure: no DB, no clock.
 *
 * The reference household takes home $6,000 a month. Needs are stated as
 * essential spend PLUS minimum debt service, so every fixture below sets both
 * — a fixture that forgets the debt service is testing a different rule.
 */

const TODAY = "2026-08-15";
const MONTHS = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"] as const;

interface Buckets {
  readonly essential: string;
  readonly discretionary: string;
  readonly unclassified?: string;
}

/** Six complete months of the same necessity split. */
function monthsOf(buckets: Buckets) {
  return makeEssentialMonths(MONTHS.map((month) => ({ month, ...buckets })));
}

/**
 * A household with the given split.
 *
 * `netIncome` and `essentials` are merged rather than replaced so a test can
 * override one field of either without silently dropping the monthly series.
 * `debtService` lands in needs alongside `essential`; the two are separate
 * inputs because they come from different tables.
 */
function household(buckets: Buckets, extra: Parameters<typeof makeAdviceInput>[0] = {}) {
  return makeAdviceInput({
    today: TODAY,
    minimumDebtService: { total: "0.00", unknownCount: 0 },
    ...extra,
    netIncome: { trailingMedian: "6000.00", ...extra.netIncome },
    essentials: {
      monthly: monthsOf(buckets),
      baseline: "3000.00",
      basisMonths: 6,
      unclassifiedShare: 0,
      ...extra.essentials,
    },
  });
}

describe("splitDiagnostic", () => {
  it("measures the three shares against observed take-home", () => {
    const split = splitDiagnostic(household({ essential: "3000.00", discretionary: "1800.00" }));

    expect(split?.needs).toBe("3000.00");
    expect(split?.wants).toBe("1800.00");
    expect(split?.saved).toBe("1200.00");
    expect(split?.observed.needs).toBeCloseTo(0.5, 4);
    expect(split?.observed.wants).toBeCloseTo(0.3, 4);
    expect(split?.observed.saved).toBeCloseTo(0.2, 4);
  });

  it("counts minimum debt service as a need", () => {
    // The mortgage is the largest need most households have and it lives in
    // `liabilities`, not in a spend category — omitting it would understate
    // needs by exactly the payment.
    const split = splitDiagnostic(
      household(
        { essential: "2400.00", discretionary: "1800.00" },
        { minimumDebtService: { total: "600.00", unknownCount: 0 } },
      ),
    );

    expect(split?.needs).toBe("3000.00");
  });

  it("measures saving as what was left, not as a savings category", () => {
    // Nothing is categorized as savings anywhere in this fixture, and the
    // household still saved $2,400 — money that stayed in checking was saved.
    const split = splitDiagnostic(household({ essential: "2400.00", discretionary: "1200.00" }));

    expect(split?.saved).toBe("2400.00");
  });

  it("subtracts unclassified spend from what was kept rather than guessing it", () => {
    const split = splitDiagnostic(
      household({ essential: "2400.00", discretionary: "1200.00", unclassified: "900.00" }),
    );

    // $900 left the household; it is not quietly added to needs or to wants,
    // where it would move the headline percentage by however much the user has
    // yet to classify.
    expect(split?.needs).toBe("2400.00");
    expect(split?.wants).toBe("1200.00");
    expect(split?.unclassified).toBe("900.00");
    expect(split?.saved).toBe("1500.00");
  });

  it("floors what was kept at zero rather than reporting negative saving", () => {
    const split = splitDiagnostic(household({ essential: "4500.00", discretionary: "2500.00" }));

    expect(split?.saved).toBe("0.00");
    expect(split?.observed.saved).toBe(0);
  });

  it("uses the household's own split when one is saved", () => {
    const split = splitDiagnostic(
      household(
        { essential: "3000.00", discretionary: "1800.00" },
        {
          household: {
            profile: makeProfile({ needsPct: "60.00", wantsPct: "20.00", savingsPct: "20.00" }),
          },
        },
      ),
    );

    expect(split?.target).toEqual({ needs: "60.00", wants: "20.00", savings: "20.00" });
    expect(split?.targetIsCustom).toBe(true);
  });

  it("falls back to 50/30/20 when no profile is saved", () => {
    const split = splitDiagnostic(household({ essential: "3000.00", discretionary: "1800.00" }));

    expect(split?.target).toEqual({ needs: "50.00", wants: "30.00", savings: "20.00" });
    expect(split?.targetIsCustom).toBe(false);
  });

  it("ignores the in-progress month", () => {
    const buckets = { essential: "3000.00", discretionary: "1800.00" };
    const split = splitDiagnostic(
      household(buckets, {
        essentials: {
          monthly: [
            ...monthsOf(buckets),
            // Mid-August: a fifth of a month of spend. Counting it would drag
            // the median needs figure down by a third.
            ...makeEssentialMonths([
              { month: "2026-08", essential: "600.00", discretionary: "300.00" },
            ]),
          ],
        },
      }),
    );

    expect(split?.basisMonths).toBe(6);
    expect(split?.needs).toBe("3000.00");
  });

  it("drops the leading run of months from before the history began", () => {
    const buckets = { essential: "3000.00", discretionary: "1800.00" };
    const split = splitDiagnostic(
      household(buckets, {
        essentials: {
          monthly: [
            ...makeEssentialMonths([{ month: "2025-12" }, { month: "2026-01" }]),
            ...monthsOf(buckets),
          ],
        },
      }),
    );

    // Two empty pre-history months are not evidence that this household once
    // spent nothing; including them would halve the median.
    expect(split?.basisMonths).toBe(6);
    expect(split?.needs).toBe("3000.00");
  });

  it("declines to compute a share of no take-home", () => {
    expect(
      splitDiagnostic(
        household(
          { essential: "3000.00", discretionary: "1800.00" },
          {
            netIncome: { trailingMedian: null },
          },
        ),
      ),
    ).toBeNull();
  });

  it("declines when there is no classified month to read", () => {
    expect(
      splitDiagnostic(
        household(
          { essential: "3000.00", discretionary: "1800.00" },
          {
            essentials: { monthly: [] },
          },
        ),
      ),
    ).toBeNull();
  });
});

describe("needsWantsSplitRule", () => {
  it("reports a household on target as ok", () => {
    const [rec] = needsWantsSplitRule.evaluate(
      household({ essential: "3000.00", discretionary: "1800.00" }),
    );

    expect(rec?.status).toBe("ok");
    expect(rec?.severity).toBe("info");
    expect(rec?.impact).toBe("0.00");
    expect(rec?.title).toContain("close to your target");
  });

  it("states the diagnostic rather than issuing an instruction", () => {
    const [rec] = needsWantsSplitRule.evaluate(
      household({ essential: "3720.00", discretionary: "1200.00" }),
    );

    // 62% of take-home. The heading reports the number; nothing here tells the
    // household to move house or cancel anything.
    expect(rec?.title).toBe("Your needs are 62.0% of take-home, against a 50% target");
    expect(rec?.currentValue).toBe("62.0");
    expect(rec?.benchmark).toBe("50");
    expect(rec?.rationale).toContain("worth knowing");
  });

  it("caps severity at warning — an expensive city is not an emergency", () => {
    const [rec] = needsWantsSplitRule.evaluate(
      household({ essential: "5400.00", discretionary: "500.00" }),
    );

    // 90% of take-home going to needs is as bad as this rule can see, and it
    // still does not reach critical.
    expect(rec?.severity).toBe("warning");
    expect(rec?.status).toBe("action");
  });

  it("sizes the needs overage in monthly dollars", () => {
    const [rec] = needsWantsSplitRule.evaluate(
      household({ essential: "3720.00", discretionary: "1200.00" }),
    );

    // $3,720 against a 50% line of $3,000.
    expect(rec?.impact).toBe("720.00");
  });

  it("reports a thin savings share as information, not a warning", () => {
    const [rec] = needsWantsSplitRule.evaluate(
      household({ essential: "2700.00", discretionary: "3000.00" }),
    );

    // Needs are within target; the household simply spends its surplus. That is
    // a choice, and it gets `info`.
    expect(rec?.severity).toBe("info");
    expect(rec?.status).toBe("action");
    expect(rec?.title).toContain("against a 20% target");
    expect(rec?.impact).toBe("900.00");
  });

  it("stays quiet about a few points of drift", () => {
    // 52% needs against a 50% target is a rounding artifact, not a finding.
    const [rec] = needsWantsSplitRule.evaluate(
      household({ essential: "3120.00", discretionary: "1600.00" }),
    );

    expect(rec?.status).toBe("ok");
  });

  it("honors a custom split in both the target and the heuristic", () => {
    const [rec] = needsWantsSplitRule.evaluate(
      household(
        { essential: "3480.00", discretionary: "1200.00" },
        {
          household: {
            profile: makeProfile({ needsPct: "60.00", wantsPct: "20.00", savingsPct: "20.00" }),
          },
        },
      ),
    );

    // 58% of take-home is over 50 but within a self-chosen 60% target.
    expect(rec?.status).toBe("ok");
    expect(rec?.benchmark).toBe("60");
    expect(rec?.heuristic).toContain("60% of take-home on needs");
  });

  it("drops confidence when a large share of spend is unclassified", () => {
    const [rec] = needsWantsSplitRule.evaluate(
      household(
        { essential: "3000.00", discretionary: "1800.00" },
        {
          essentials: { unclassifiedShare: 0.4 },
        },
      ),
    );

    expect(rec?.confidence).toBe("low");
  });

  it("shows unclassified spend as its own input with somewhere to fix it", () => {
    const [rec] = needsWantsSplitRule.evaluate(
      household({ essential: "2400.00", discretionary: "1200.00", unclassified: "900.00" }),
    );
    const unclassified = rec?.inputsUsed.find((i) => i.label === "Unclassified spend");

    expect(unclassified?.value).toBe("900.00");
    expect(unclassified?.href).toBe("/settings/categories");
  });

  it("names the missing input when there is no observed take-home", () => {
    const [rec] = needsWantsSplitRule.evaluate(
      household(
        { essential: "3000.00", discretionary: "1800.00" },
        {
          netIncome: { trailingMedian: null },
        },
      ),
    );

    expect(rec?.status).toBe("unknown_input");
    expect(rec?.impact).toBeNull();
    expect(rec?.currentValue).toBeNull();
    const missing = rec?.inputsUsed.find((i) => i.missing);
    expect(missing?.label).toBe("Observed take-home");
    expect(missing?.value).toBeNull();
  });

  it("needs six months before a proportion means anything", () => {
    expect(needsWantsSplitRule.minMonthsHistory).toBe(6);
  });

  it("keeps one stable id — this is a household-level diagnostic", () => {
    const [rec] = needsWantsSplitRule.evaluate(
      household({ essential: "3000.00", discretionary: "1800.00" }),
    );

    expect(rec?.id).toBe("needs_wants_split:");
    expect(rec?.subjectKey).toBe("");
  });
});
