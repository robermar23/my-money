// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type IncomeDeposit, suggestTakeHome } from "./take-home-suggestion.ts";

/**
 * ADR-049 §2 — the take-home suggestion. Fixtures mirror the household the
 * feature was built for: two SSA benefits from one payer on the 15th, and a
 * biweekly salary.
 */

const TODAY = "2026-10-08";

function monthly(name: string, amount: string, day: string, months: readonly string[]) {
  return months.map((m) => ({ postedAt: `2026-${m}-${day}`, amount, name }));
}

const SSA_MONTHS = ["05", "06", "07", "08", "09"] as const;
const ssa: IncomeDeposit[] = [
  ...monthly("SSA TREAS 310 XXSOC SEC", "3251.00", "15", SSA_MONTHS),
  ...monthly("SSA TREAS 310 XXSOC SEC", "1625.00", "15", SSA_MONTHS),
];
const salary: IncomeDeposit[] = [
  "2026-07-17",
  "2026-07-31",
  "2026-08-14",
  "2026-08-28",
  "2026-09-11",
  "2026-09-25",
].map((postedAt, i) => ({
  postedAt,
  amount: i === 5 ? "4912.40" : "4900.12",
  name: `THE AGORA PAYROLL PPD ID ${1000 + i}`,
}));

describe("suggestTakeHome", () => {
  it("splits one payer's two same-day benefits into two streams, closest to gross first", () => {
    const schedule = {
      cadence: "monthly" as const,
      anchorDate: "2026-08-15",
      startDate: "2025-07-15",
      endDate: null,
    };

    const forErica = suggestTakeHome({ ...schedule, grossPerPeriod: "3251.00" }, ssa, TODAY);
    const forSam = suggestTakeHome({ ...schedule, grossPerPeriod: "1625.00" }, ssa, TODAY);

    expect(forErica.map((c) => c.amount)).toEqual(["3251.00", "1625.00"]);
    expect(forSam.map((c) => c.amount)).toEqual(["1625.00", "3251.00"]);
    expect(forErica[0]?.payee).toBe("SSA TREAS XXSOC SEC");
  });

  it("matches a biweekly salary and suggests the median of its deposits", () => {
    const [best, ...rest] = suggestTakeHome(
      {
        cadence: "biweekly",
        anchorDate: "2026-07-17",
        startDate: "2026-07-17",
        endDate: null,
      },
      [...salary, ...ssa],
      TODAY,
    );

    expect(best?.payee).toBe("THE AGORA PAYROLL PPD ID");
    expect(best?.amount).toBe("4900.12");
    expect(best?.latestAmount).toBe("4912.40");
    expect(best?.latestDate).toBe("2026-09-25");
    // 7/17 … 10/09 has seven paydays through today; six have posted.
    expect(best?.matchedPaydays).toBe(6);
    expect(rest).toEqual([]);
  });

  it("accepts a deposit that posts early for a weekend payday", () => {
    const early = salary.map((d) =>
      d.postedAt === "2026-08-14" ? { ...d, postedAt: "2026-08-12" } : d,
    );
    const [best] = suggestTakeHome(
      { cadence: "biweekly", anchorDate: "2026-07-17", startDate: "2026-07-17", endDate: null },
      early,
      TODAY,
    );
    expect(best?.matchedPaydays).toBe(6);
  });

  it("does not offer a weekly deposit as a monthly paycheck", () => {
    const weekly: IncomeDeposit[] = [];
    for (let day = 1; day <= 28; day += 7) {
      for (const m of SSA_MONTHS) {
        weekly.push({
          postedAt: `2026-${m}-${String(day).padStart(2, "0")}`,
          amount: "300.00",
          name: "GIG APP",
        });
      }
    }
    expect(
      suggestTakeHome(
        { cadence: "monthly", anchorDate: "2026-08-15", startDate: "2025-01-01", endDate: null },
        weekly,
        TODAY,
      ),
    ).toEqual([]);
  });

  it("ignores deposits before the source started", () => {
    // The old salary paid on the same Fridays; the new source starts 7/17.
    const old = ["2026-06-05", "2026-06-19", "2026-07-03"].map((postedAt) => ({
      postedAt,
      amount: "4400.00",
      name: "THE AGORA PAYROLL",
    }));
    const [best] = suggestTakeHome(
      { cadence: "biweekly", anchorDate: "2026-07-17", startDate: "2026-07-17", endDate: null },
      [...old, ...salary],
      TODAY,
    );
    expect(best?.amount).toBe("4900.12");
  });

  it("returns nothing when there are no deposits or no payday yet", () => {
    const schedule = {
      cadence: "monthly" as const,
      anchorDate: "2026-08-15",
      startDate: "2025-07-15",
      endDate: null,
    };
    expect(suggestTakeHome(schedule, [], TODAY)).toEqual([]);
    expect(suggestTakeHome({ ...schedule, startDate: "2026-12-01" }, ssa, TODAY)).toEqual([]);
  });
});
