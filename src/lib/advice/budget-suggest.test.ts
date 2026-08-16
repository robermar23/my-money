// @vitest-environment node
import { forecastMonthlySpend } from "@/lib/analytics/forecast.ts";
import { describe, expect, it } from "vitest";
import { makeMonthlySpend } from "./advice-input.fixture.ts";
import { suggestBudgets, suggestionFor } from "./budget-suggest.ts";

/*
 * P15-24 — the budget suggester. Pure: no DB, no clock.
 *
 * The reference category "auto" spends $200 in five ordinary months and $2,000
 * in the sixth, when the transmission went. Every divergence between a budget
 * target and a spend forecast shows up on this one fixture.
 */

const AUTO = "auto";
const GROCERIES = "groceries";

const ORDINARY_MONTHS = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07"] as const;

/** Five $200 months, then a $2,000 repair month. Groceries steady throughout. */
const WITH_OUTLIER = makeMonthlySpend([
  ...ORDINARY_MONTHS.map((month) => ({
    month,
    byCategory: { [AUTO]: "200.00", [GROCERIES]: "600.00" },
    income: "6000.00",
  })),
  {
    month: "2026-08",
    byCategory: { [AUTO]: "2000.00", [GROCERIES]: "600.00" },
    income: "6000.00",
  },
]);

describe("suggestBudgets — the median is the target-setting statistic", () => {
  it("leaves the target where an ordinary month lands despite the outlier", () => {
    const auto = suggestionFor(suggestBudgets(WITH_OUTLIER), AUTO);

    expect(auto?.suggested).toBe("200.00");
    expect(auto?.basis).toBe("median");
  });

  it("diverges from the trailing mean, which the outlier does move", () => {
    // The whole reason ADR-034 §3 exists, stated in numbers rather than a
    // comment: same six months, same category, two different right answers.
    // Mean of [200,200,200,200,200,2000] = 500; median = 200.
    const forecast = forecastMonthlySpend(WITH_OUTLIER, { months: 6 });
    const suggestion = suggestionFor(suggestBudgets(WITH_OUTLIER, { months: 6 }), AUTO);

    expect(forecast.byCategory[AUTO]).toBe("500.00");
    expect(suggestion?.suggested).toBe("200.00");

    // A budget built on the forecast would be missed in five months of six.
    // Nobody should "reconcile" these two functions later.
    expect(suggestion?.suggested).not.toBe(forecast.byCategory[AUTO]);
  });

  it("agrees with the mean when no month is an outlier", () => {
    const forecast = forecastMonthlySpend(WITH_OUTLIER, { months: 6 });
    const suggestion = suggestionFor(suggestBudgets(WITH_OUTLIER, { months: 6 }), GROCERIES);

    expect(suggestion?.suggested).toBe("600.00");
    expect(forecast.byCategory[GROCERIES]).toBe("600.00");
  });

  it("reports the observed range so the outlier is visible, not hidden", () => {
    const auto = suggestionFor(suggestBudgets(WITH_OUTLIER), AUTO);

    // The median suppresses the repair's effect on the target — it must not
    // suppress the user's knowledge that the repair happened.
    expect(auto?.observedRange).toEqual({ min: "200.00", max: "2000.00" });
  });

  it("offers p75 for a household that wants headroom", () => {
    const auto = suggestionFor(suggestBudgets(WITH_OUTLIER, { basis: "p75" }), AUTO);

    // R-7 over [200,200,200,200,200,2000] at p=0.75: rank 3.75 → still $200
    // between ranks 3 and 4, which are both 200. p75 buys headroom only where
    // the spread is in the upper half.
    expect(auto?.suggested).toBe("200.00");
    expect(auto?.basis).toBe("p75");
  });

  it("p75 lifts the target on a genuinely variable category", () => {
    const variable = makeMonthlySpend(
      ["100.00", "200.00", "300.00", "400.00", "500.00"].map((amount, i) => ({
        month: `2026-0${i + 3}`,
        byCategory: { [AUTO]: amount },
        income: "6000.00",
      })),
    );

    expect(suggestionFor(suggestBudgets(variable), AUTO)?.suggested).toBe("300.00");
    expect(suggestionFor(suggestBudgets(variable, { basis: "p75" }), AUTO)?.suggested).toBe(
      "400.00",
    );
  });
});

describe("suggestBudgets — history handling", () => {
  it("drops the leading run of empty months so an import does not dilute targets", () => {
    const lateStart = makeMonthlySpend([
      { month: "2026-01" },
      { month: "2026-02" },
      { month: "2026-03", byCategory: { [AUTO]: "300.00" }, income: "6000.00" },
      { month: "2026-04", byCategory: { [AUTO]: "300.00" }, income: "6000.00" },
      { month: "2026-05", byCategory: { [AUTO]: "300.00" }, income: "6000.00" },
    ]);

    const auto = suggestionFor(suggestBudgets(lateStart), AUTO);

    // Three real months, not five — the two pre-history months are not
    // evidence that this household spends $0 on Auto.
    expect(auto?.basisMonths).toBe(3);
    expect(auto?.suggested).toBe("300.00");
  });

  it("keeps interior zero months, which are real evidence", () => {
    const gappy = makeMonthlySpend([
      { month: "2026-03", byCategory: { [AUTO]: "600.00" }, income: "6000.00" },
      { month: "2026-04", byCategory: { [GROCERIES]: "500.00" }, income: "6000.00" },
      { month: "2026-05", byCategory: { [GROCERIES]: "500.00" }, income: "6000.00" },
      { month: "2026-06", byCategory: { [AUTO]: "600.00" }, income: "6000.00" },
    ]);

    const auto = suggestionFor(suggestBudgets(gappy), AUTO);

    // Median of [600, 0, 0, 600] = 300 — two months of spending $600 and two of
    // spending nothing averages to a $300 monthly target, which is right.
    expect(auto?.basisMonths).toBe(4);
    expect(auto?.monthsWithSpend).toBe(2);
    expect(auto?.suggested).toBe("300.00");
  });

  it("offers nothing at all below the minimum history", () => {
    const twoMonths = makeMonthlySpend([
      { month: "2026-07", byCategory: { [AUTO]: "300.00" }, income: "6000.00" },
      { month: "2026-08", byCategory: { [AUTO]: "300.00" }, income: "6000.00" },
    ]);

    // Two months cannot tell a habit from a coincidence. Silence, not a guess.
    expect(suggestBudgets(twoMonths)).toEqual([]);
  });

  it("returns nothing for a history with no activity anywhere", () => {
    expect(suggestBudgets(makeMonthlySpend([{ month: "2026-07" }, { month: "2026-08" }]))).toEqual(
      [],
    );
    expect(suggestBudgets([])).toEqual([]);
  });

  it("honors a custom window, ignoring months before it", () => {
    const shifted = makeMonthlySpend([
      { month: "2026-05", byCategory: { [AUTO]: "1000.00" }, income: "6000.00" },
      { month: "2026-06", byCategory: { [AUTO]: "100.00" }, income: "6000.00" },
      { month: "2026-07", byCategory: { [AUTO]: "100.00" }, income: "6000.00" },
      { month: "2026-08", byCategory: { [AUTO]: "100.00" }, income: "6000.00" },
    ]);

    expect(suggestionFor(suggestBudgets(shifted, { months: 3 }), AUTO)?.suggested).toBe("100.00");
    expect(suggestionFor(suggestBudgets(shifted, { months: 3 }), AUTO)?.basisMonths).toBe(3);
  });
});

describe("suggestBudgets — confidence and sporadic categories", () => {
  it("suggests zero for a category the household rarely spends in", () => {
    const sporadic = makeMonthlySpend([
      { month: "2026-03", byCategory: { [GROCERIES]: "500.00" }, income: "6000.00" },
      { month: "2026-04", byCategory: { [GROCERIES]: "500.00" }, income: "6000.00" },
      { month: "2026-05", byCategory: { [GROCERIES]: "500.00" }, income: "6000.00" },
      { month: "2026-06", byCategory: { [GROCERIES]: "500.00" }, income: "6000.00" },
      { month: "2026-07", byCategory: { [GROCERIES]: "500.00", [AUTO]: "900.00" }, income: "0.00" },
    ]);

    const auto = suggestionFor(suggestBudgets(sporadic), AUTO);

    // Median of [0,0,0,0,900] is genuinely zero, and saying so is honest. The
    // preview layer is what declines to offer a $0 target to the user.
    expect(auto?.suggested).toBe("0.00");
    expect(auto?.monthsWithSpend).toBe(1);
    expect(auto?.confidence).toBe("low");
  });

  it("grades confidence on history depth", () => {
    const months = (count: number) =>
      makeMonthlySpend(
        Array.from({ length: count }, (_, i) => ({
          month: `2026-${String(i + 1).padStart(2, "0")}`,
          byCategory: { [AUTO]: "300.00" },
          income: "6000.00",
        })),
      );

    expect(suggestionFor(suggestBudgets(months(4), { months: 24 }), AUTO)?.confidence).toBe("low");
    expect(suggestionFor(suggestBudgets(months(8), { months: 24 }), AUTO)?.confidence).toBe(
      "medium",
    );
    expect(suggestionFor(suggestBudgets(months(12), { months: 24 }), AUTO)?.confidence).toBe(
      "high",
    );
  });

  it("orders by target size, largest first", () => {
    const suggestions = suggestBudgets(WITH_OUTLIER);

    expect(suggestions.map((s) => s.categoryId)).toEqual([GROCERIES, AUTO]);
  });

  it("returns null from suggestionFor for a category with no spend", () => {
    expect(suggestionFor(suggestBudgets(WITH_OUTLIER), "never-spent")).toBeNull();
  });
});
