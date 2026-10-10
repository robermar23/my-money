// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import { accrue } from "./accrual.ts";
import type { KnownFutureCost } from "./types.ts";

/**
 * P18-07 — `accrue` (ADR-044). Written before the implementation and watched
 * fail, because this is the always-test surface of the phase: CLAUDE.md
 * §Testing Philosophy names money helpers and amortization math explicitly, and
 * accrual is division, which is where money math goes wrong.
 *
 * **Every money assertion is against a string literal.** Not `toBeCloseTo`, not
 * a `Number()` comparison: the figure this feature is judged on is the one the
 * household reads, and a test that tolerates a cent cannot detect the drift
 * ADR-044 exists to eliminate.
 */

const CURRENCY = "USD";

/** A typed fixture factory, so a new required field fails here once. */
const cost = (overrides: Partial<KnownFutureCost> = {}): KnownFutureCost => ({
  source: "planned_expense",
  sourceId: "11111111-1111-4111-8111-111111111111",
  label: "New roof",
  amount: "6000.00",
  currency: CURRENCY,
  dueDate: "2027-01-01",
  fundingStart: "2026-01-01",
  status: "planned",
  categoryId: null,
  ...overrides,
});

describe("accrue — the twelve-month case", () => {
  it("splits the amount evenly and requires nothing on the funding start", () => {
    const result = accrue(cost(), "2026-01-01");
    expect(result.totalMonths).toBe(12);
    expect(result.elapsedMonths).toBe(0);
    expect(result.perMonth).toBe("500.00");
    // Nothing is owed on the day you decide to start. ADR-044 §4 — the whole
    // reason `fundingStart` is stored rather than inferred.
    expect(result.requiredToday).toBe("0.00");
    expect(result.pastDue).toBe(false);
  });

  it("requires half of it halfway through", () => {
    const result = accrue(cost(), "2026-07-01");
    expect(result.elapsedMonths).toBe(6);
    expect(result.requiredToday).toBe("3000.00");
  });

  it("requires the whole bill on the due date, exactly, as a string", () => {
    // ADR-044 §1. On the day the bill is due the requirement IS the bill. This
    // is the assertion the one-division rule exists to make true.
    const result = accrue(cost(), "2027-01-01");
    expect(result.elapsedMonths).toBe(12);
    expect(result.requiredToday).toBe("6000.00");
    expect(result.pastDue).toBe(false);
  });
});

describe("accrue — the two clamps (ADR-044 §5)", () => {
  it("requires nothing before the funding start", () => {
    const result = accrue(cost({ fundingStart: "2026-06-01" }), "2026-01-15");
    expect(result.elapsedMonths).toBe(0);
    expect(result.requiredToday).toBe("0.00");
  });

  it("never requires more than the amount once the due date has passed", () => {
    const result = accrue(
      cost({ fundingStart: "2025-01-01", dueDate: "2026-01-01" }),
      "2026-05-01",
    );
    // Four months past due: unclamped, elapsed would be 16 and the requirement
    // $8,000 against a $6,000 bill.
    expect(result.totalMonths).toBe(12);
    expect(result.elapsedMonths).toBe(12);
    expect(result.requiredToday).toBe("6000.00");
    expect(result.pastDue).toBe(true);
  });
});

describe("accrue — short and degenerate terms (ADR-044 §3)", () => {
  it("treats a cost due in ten days as 'you need all of it now'", () => {
    const soon = cost({ fundingStart: "2026-10-04", dueDate: "2026-10-14", amount: "400.00" });

    const atStart = accrue(soon, "2026-10-04");
    expect(atStart.totalMonths).toBe(1);
    expect(atStart.perMonth).toBe("400.00");
    expect(atStart.requiredToday).toBe("0.00");

    // Whole months, not days (ADR-044 §6): the figure does not creep every
    // morning. The day before it is due, nothing is required yet.
    expect(accrue(soon, "2026-10-13").requiredToday).toBe("0.00");

    // On the due date it is the whole bill — the identity ADR-044 §1 promises,
    // and the case the month count alone gets WRONG once the §3 floor applies:
    // this cost crosses no month boundary before it lands.
    const onDueDate = accrue(soon, "2026-10-14");
    expect(onDueDate.elapsedMonths).toBe(1);
    expect(onDueDate.requiredToday).toBe("400.00");

    // And it stays the whole bill afterwards, rather than falling back to
    // "0.00" until the next month boundary (ADR-044 §5).
    const pastDue = accrue(soon, "2026-10-20");
    expect(pastDue.requiredToday).toBe("400.00");
    expect(pastDue.pastDue).toBe(true);
  });

  it("does not divide by zero when the funding start is the due date", () => {
    const sameDay = cost({ fundingStart: "2026-05-10", dueDate: "2026-05-10", amount: "250.00" });
    const result = accrue(sameDay, "2026-05-10");
    expect(result.totalMonths).toBe(1);
    expect(result.perMonth).toBe("250.00");
    expect(result.requiredToday).toBe("250.00");
  });
});

describe("accrue — an amount that does not divide evenly", () => {
  // Round 12's own example: $1,340 of car insurance over seven months.
  const premium = cost({
    label: "Car insurance",
    amount: "1340.00",
    fundingStart: "2026-03-01",
    dueDate: "2026-10-01",
  });

  it("is exact on the due date despite the uneven split", () => {
    const result = accrue(premium, "2026-10-01");
    expect(result.totalMonths).toBe(7);
    expect(result.requiredToday).toBe("1340.00");
  });

  it("CAPTURES the drift the literal formula would have produced", () => {
    // IDEAS3's Round 12.2 states the math as `elapsed × perMonth`. Taken
    // literally that rounds twice: $1,340 ÷ 7 is $191.43, and seven of those is
    // $1,340.01 — a cent the household never owed. ADR-044 computes
    // `amount × elapsed ÷ total` instead, with ONE rounding.
    //
    // This assertion is the regression, not folklore: it pins the fact that the
    // two formulas genuinely differ, so nobody "simplifies" the authoritative
    // figure into a multiplication of the display figure.
    const result = accrue(premium, "2026-10-01");
    expect(result.perMonth).toBe("191.43");
    const literalFormula = Money.fromString(result.perMonth, CURRENCY).mul(result.totalMonths);
    expect(literalFormula.toString()).toBe("1340.01");
    expect(literalFormula.toString()).not.toBe(result.requiredToday);
  });

  it("stays monotone and under the cap at every intermediate month", () => {
    const expected = ["0.00", "191.43", "382.86", "574.29", "765.71", "957.14", "1148.57"];
    const months = [
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
    ];
    expect(months.map((today) => accrue(premium, today).requiredToday)).toEqual(expected);
  });
});

describe("accrue — a settled cost contributes nothing (ADR-044 §7)", () => {
  it("accrues 0.00 for a paid cost", () => {
    const result = accrue(cost({ status: "paid" }), "2026-07-01");
    expect(result.requiredToday).toBe("0.00");
    expect(result.perMonth).toBe("0.00");
    expect(result.elapsedMonths).toBe(0);
  });

  it("accrues 0.00 for a cancelled cost", () => {
    const result = accrue(cost({ status: "cancelled" }), "2026-07-01");
    expect(result.requiredToday).toBe("0.00");
    expect(result.perMonth).toBe("0.00");
  });

  it("does not report a settled cost as past due", () => {
    // A bill that was paid is not overdue, and a cost that was cancelled is not
    // a cost. The row stays visible with its status; it just has no ask.
    const settled = cost({ status: "paid", dueDate: "2026-01-01" });
    expect(accrue(settled, "2026-07-01").pastDue).toBe(false);
  });

  it("still reports the real term, so the row renders with its own history", () => {
    const result = accrue(cost({ status: "paid" }), "2026-07-01");
    expect(result.totalMonths).toBe(12);
  });
});

describe("accrue — purity and currency", () => {
  it("returns the cost it was given, unmodified", () => {
    const input = cost();
    const result = accrue(input, "2026-07-01");
    expect(result.cost).toBe(input);
    expect(input.amount).toBe("6000.00");
  });

  it("carries a non-USD cost's own currency through", () => {
    const result = accrue(cost({ amount: "1200.00", currency: "EUR" }), "2026-04-01");
    expect(result.requiredToday).toBe("300.00");
  });

  it("rejects a date that is not a real calendar date", () => {
    // Delegated to the one shipped `parseIsoDate`; this module writes no date
    // math of its own, so the guarantee is inherited rather than reimplemented.
    expect(() => accrue(cost(), "2026-13-01")).toThrow();
    expect(() => accrue(cost({ dueDate: "2026-02-30" }), "2026-01-01")).toThrow();
  });
});
