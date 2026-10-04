// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import { monthsBetween, parseIsoDate } from "@/lib/schedule/occurrences.ts";
import { describe, expect, it } from "vitest";
import { accrue } from "./accrual.ts";
import type { AccruedCost, KnownFutureCost } from "./types.ts";

/**
 * P18-08 — the accrual invariants (ADR-044).
 *
 * **This file exists on its own so it cannot be folded into another suite and
 * forgotten.** [accrual.test.ts](./accrual.test.ts) checks named cases; this
 * checks the four properties that must hold on *every* day of a cost's life,
 * because a household watching this figure will notice a violation long before
 * a test would:
 *
 *   1. `requiredToday` is **non-decreasing** as `today` advances. A requirement
 *      that goes down without the cost changing tells the household they are
 *      suddenly further ahead than they were yesterday, which is never true.
 *   2. It **never exceeds** `amount`. Asking for more than the bill is the
 *      single most obvious way to lose a reader's trust.
 *   3. It is exactly `"0.00"` **before the funding start**. You owe nothing on a
 *      plan you have not started (ADR-044 §4).
 *   4. It is exactly `amount` **from the due date onward** — as a string, not
 *      within a cent (ADR-044 §1/§5).
 *
 * ── Proving the suite has teeth ────────────────────────────────────────────
 * A green invariant suite that cannot fail is worse than none: it is a comment
 * that looks like a guarantee. So three deliberately broken implementations are
 * built by hand below and the invariant is shown catching each one — the same
 * discipline P16-16 and P17-12 used. One of the three is not hypothetical: it is
 * the exact bug the first draft of `accrue` shipped, which
 * [accrual.test.ts](./accrual.test.ts) caught during P18-07.
 *
 * ── Scaffolding, not date math ─────────────────────────────────────────────
 * The day stepper below is local to this file. Production code in
 * `src/lib/sinking/` writes no date arithmetic of its own (ADR-036 §5); a test
 * that walks a calendar needs to step days, and it does so through the shipped
 * `parseIsoDate` rather than parsing a date string by hand.
 */

const MS_PER_DAY = 86_400_000;
const CURRENCY = "USD";

/** `YYYY-MM-DD` shifted by whole days, via the one shipped ISO parser. */
function shiftDays(iso: string, days: number): string {
  return new Date(parseIsoDate(iso, "iso") + days * MS_PER_DAY).toISOString().slice(0, 10);
}

const cost = (overrides: Partial<KnownFutureCost>): KnownFutureCost => ({
  source: "planned_expense",
  sourceId: "11111111-1111-4111-8111-111111111111",
  label: "A known cost",
  amount: "6000.00",
  currency: CURRENCY,
  dueDate: "2027-01-01",
  fundingStart: "2026-01-01",
  status: "planned",
  categoryId: null,
  ...overrides,
});

/**
 * The fixture set, chosen so each row stresses a different edge of the identity
 * rather than repeating the easy case.
 */
const CASES: readonly { readonly name: string; readonly cost: KnownFutureCost }[] = [
  {
    name: "a year, dividing evenly",
    cost: cost({ amount: "6000.00", fundingStart: "2026-01-01", dueDate: "2027-01-01" }),
  },
  {
    name: "seven months, dividing unevenly (Round 12's car insurance)",
    cost: cost({ amount: "1340.00", fundingStart: "2026-03-01", dueDate: "2026-10-01" }),
  },
  {
    name: "eighteen months, a long roof",
    cost: cost({ amount: "9400.00", fundingStart: "2026-01-15", dueDate: "2027-07-10" }),
  },
  {
    name: "ten days — the totalMonths floor (ADR-044 §3)",
    cost: cost({ amount: "400.00", fundingStart: "2026-10-04", dueDate: "2026-10-14" }),
  },
  {
    name: "funding start equal to the due date",
    cost: cost({ amount: "250.00", fundingStart: "2026-05-10", dueDate: "2026-05-10" }),
  },
  {
    name: "an amount smaller than its term, so most months round to the same cent",
    cost: cost({ amount: "33.33", fundingStart: "2026-02-01", dueDate: "2026-07-01" }),
  },
  {
    name: "a mid-month term, where month boundaries and anniversaries disagree",
    cost: cost({ amount: "1875.50", fundingStart: "2026-01-31", dueDate: "2026-06-01" }),
  },
];

/** The signature every implementation under test shares. */
type Accrue = (cost: KnownFutureCost, today: string) => AccruedCost;

/**
 * Assert the four invariants across every day from `fundingStart − 1` to
 * `dueDate + 40`, for one cost.
 *
 * @throws The first failing expectation, naming the day it failed on — so a
 *   regression reports "2026-10-14" rather than "the sweep failed".
 */
function assertInvariants(impl: Accrue, subject: KnownFutureCost): void {
  const amount = Money.fromString(subject.amount, subject.currency);
  const first = shiftDays(subject.fundingStart, -1);
  const last = shiftDays(subject.dueDate, 40);
  let previous = Money.zero(subject.currency);

  for (let today = first; today <= last; today = shiftDays(today, 1)) {
    const result = impl(subject, today);
    const required = Money.fromString(result.requiredToday, subject.currency);

    // (1) non-decreasing.
    expect(
      required.compare(previous),
      `${today}: requiredToday went backwards (${previous.toString()} → ${result.requiredToday})`,
    ).toBeGreaterThanOrEqual(0);

    // (2) never above the bill.
    expect(
      required.compare(amount),
      `${today}: requiredToday ${result.requiredToday} exceeds the cost ${subject.amount}`,
    ).toBeLessThanOrEqual(0);

    // (3) nothing before the start.
    if (today < subject.fundingStart) {
      expect(result.requiredToday, `${today}: before the funding start`).toBe("0.00");
    }

    // (4) the whole bill from the due date onward, as a string.
    if (today >= subject.dueDate) {
      expect(result.requiredToday, `${today}: on or after the due date`).toBe(amount.toString());
    }

    previous = required;
  }
}

describe("accrual invariants (ADR-044) — the shipped implementation", () => {
  for (const testCase of CASES) {
    it(`holds day by day for ${testCase.name}`, () => {
      assertInvariants(accrue, testCase.cost);
    });
  }

  it("holds for a settled cost, which simply never accrues", () => {
    // `"0.00"` every day is trivially non-decreasing and under the cap; what
    // this pins is that a paid cost does not acquire a requirement on its due
    // date through invariant (4)'s own logic.
    const paid = cost({ status: "paid", amount: "6000.00" });
    const days = ["2025-12-31", "2026-06-01", "2027-01-01", "2027-06-01"];
    expect(days.map((today) => accrue(paid, today).requiredToday)).toEqual([
      "0.00",
      "0.00",
      "0.00",
      "0.00",
    ]);
  });

  it("keeps perMonth constant over a cost's life — it is a property of the cost", () => {
    const subject = CASES[1]?.cost;
    if (!subject) throw new Error("fixture missing");
    const seen = new Set<string>();
    for (
      let today = shiftDays(subject.fundingStart, -1);
      today <= shiftDays(subject.dueDate, 40);
      today = shiftDays(today, 1)
    ) {
      seen.add(accrue(subject, today).perMonth);
    }
    expect([...seen]).toEqual(["191.43"]);
  });
});

/**
 * ── The three broken implementations ───────────────────────────────────────
 * Each drops exactly one thing ADR-044 states, and each must be CAUGHT. If one
 * of these ever passes, the invariant above has stopped protecting that rule.
 */

/** Elapsed months unclamped: no upper bound at all (ADR-044 §5 removed). */
const brokenUnclampedElapsed: Accrue = (subject, today) => {
  const totalMonths = Math.max(1, monthsBetween(subject.fundingStart, subject.dueDate));
  const elapsedMonths = monthsBetween(subject.fundingStart, today);
  const amount = Money.fromString(subject.amount, subject.currency);
  return {
    cost: subject,
    totalMonths,
    elapsedMonths,
    perMonth: amount.div(totalMonths).toString(),
    requiredToday: amount.mul(elapsedMonths).div(totalMonths).toString(),
    pastDue: subject.dueDate < today,
  };
};

/**
 * The month count clamped but the due date ignored — the ceiling reached only
 * when `monthsBetween` says so.
 *
 * **This is the bug the first draft of `accrue` actually had**, and it is the
 * reason this variant is listed first among the ones worth guarding: it looks
 * exactly like a correct clamp. For a cost due inside a month it requires
 * `"0.00"` on the due date and for weeks afterwards.
 */
const brokenCeilingByMonthCountOnly: Accrue = (subject, today) => {
  const totalMonths = Math.max(1, monthsBetween(subject.fundingStart, subject.dueDate));
  const elapsedMonths = Math.min(totalMonths, monthsBetween(subject.fundingStart, today));
  const amount = Money.fromString(subject.amount, subject.currency);
  return {
    cost: subject,
    totalMonths,
    elapsedMonths,
    perMonth: amount.div(totalMonths).toString(),
    requiredToday: amount.mul(elapsedMonths).div(totalMonths).toString(),
    pastDue: subject.dueDate < today,
  };
};

/** IDEAS3's literal formula: `perMonth × elapsed`, which rounds twice. */
const brokenLiteralFormula: Accrue = (subject, today) => {
  const totalMonths = Math.max(1, monthsBetween(subject.fundingStart, subject.dueDate));
  const elapsedMonths =
    subject.dueDate <= today
      ? totalMonths
      : Math.min(totalMonths, monthsBetween(subject.fundingStart, today));
  const amount = Money.fromString(subject.amount, subject.currency);
  const perMonth = amount.div(totalMonths);
  return {
    cost: subject,
    totalMonths,
    elapsedMonths,
    perMonth: perMonth.toString(),
    requiredToday: perMonth.mul(elapsedMonths).toString(),
    pastDue: subject.dueDate < today,
  };
};

describe("accrual invariants — the suite is not vacuous", () => {
  it("CATCHES an unclamped elapsed count", () => {
    // Four months past due on a twelve-month term asks for $8,000 of a $6,000
    // bill. Invariant (2).
    expect(() => assertInvariants(brokenUnclampedElapsed, cost({}))).toThrow();
  });

  it("CATCHES a ceiling that trusts the month count over the due date", () => {
    // The ten-day cost: `monthsBetween` is still 0 on the day it lands.
    const soon = cost({ amount: "400.00", fundingStart: "2026-10-04", dueDate: "2026-10-14" });
    expect(() => assertInvariants(brokenCeilingByMonthCountOnly, soon)).toThrow();
  });

  it("CATCHES the literal `perMonth × elapsed` formula", () => {
    // $191.43 × 7 = $1,340.01 against a $1,340.00 bill. Invariant (2), and the
    // whole reason ADR-044 divides once.
    const premium = cost({ amount: "1340.00", fundingStart: "2026-03-01", dueDate: "2026-10-01" });
    expect(() => assertInvariants(brokenLiteralFormula, premium)).toThrow();
  });

  it("CATCHES the literal formula's shortfall too, not just its overshoot", () => {
    // Rounding can also go the other way: $33.33 over 5 months is $6.67 a
    // month, and five of those is $33.35 — but $1,875.50 over 5 months is
    // $375.10, and five of those is exactly right, so the defect is amount-
    // dependent. This case pins one where the literal formula lands SHORT of
    // the bill on the due date, which invariant (4) rejects as a string
    // mismatch even though invariant (2) would allow it.
    const odd = cost({ amount: "1000.00", fundingStart: "2026-01-01", dueDate: "2026-04-01" });
    expect(() => assertInvariants(brokenLiteralFormula, odd)).toThrow();
  });
});
