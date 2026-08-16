// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, categories, transactions } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { type NetIncomeRow, computeObservedNetIncome, observedNetIncome } from "./net-income.ts";

/*
 * P15-08 — observed net income (ADR-034 §1).
 *
 * The pure-core block needs no database; the query block uses the real one to
 * prove the two things only SQL can prove: that `kind='transfer'` never reaches
 * the fold, and that excluded categories are FETCHED (so they can be listed)
 * rather than filtered away in the WHERE clause.
 */

const WINDOW = { from: "2026-01-01", to: "2026-06-30" };

function row(partial: Partial<NetIncomeRow> & { month: string; sum: string }): NetIncomeRow {
  return {
    categoryId: "cat-salary",
    categoryName: "Salary",
    excludedFromBaseline: false,
    ...partial,
  };
}

describe("computeObservedNetIncome", () => {
  it("emits a gap-free monthly series across the whole window", () => {
    const result = computeObservedNetIncome([row({ month: "2026-03", sum: "5000.00" })], WINDOW);

    expect(result.monthly.map((m) => m.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
    ]);
    // Months after income began are real zeros, not omissions.
    expect(result.monthly.find((m) => m.month === "2026-04")?.amount).toBe("0.00");
  });

  it("drops excluded categories from the totals but still lists them", () => {
    const result = computeObservedNetIncome(
      [
        row({ month: "2026-01", sum: "4000.00" }),
        row({
          month: "2026-01",
          sum: "900.00",
          categoryId: "cat-reimb",
          categoryName: "Reimbursements",
          excludedFromBaseline: true,
        }),
      ],
      WINDOW,
    );

    expect(result.monthly.find((m) => m.month === "2026-01")?.amount).toBe("4000.00");

    // Listing the excluded row is the point of ADR-034 §1: the user can only
    // put a wrongly-excluded category back if they can see it was left out.
    const reimb = result.contributingCategories.find((c) => c.categoryId === "cat-reimb");
    expect(reimb).toMatchObject({ name: "Reimbursements", total: "900.00", excluded: true });
  });

  it("a bonus month barely moves the median", () => {
    // Six months of $4,000 take-home, one of which included a $12,000 bonus.
    const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
    const steady = months.map((month) => row({ month, sum: "4000.00" }));
    const withBonus = [...steady, row({ month: "2026-04", sum: "12000.00" })];

    expect(computeObservedNetIncome(steady, WINDOW).trailingMedian).toBe("4000.00");
    expect(computeObservedNetIncome(withBonus, WINDOW).trailingMedian).toBe("4000.00");

    // The mean would have moved from 4,000 to 6,000 — a 50% overstatement of
    // take-home carried into every benchmark for a year.
    const withBonusResult = computeObservedNetIncome(withBonus, WINDOW);
    expect(withBonusResult.windowTotal).toBe("36000.00");
  });

  it("drops leading empty months from the median basis but keeps interior zeros", () => {
    // Income starts in April; Jan–Mar predate the history entirely.
    const result = computeObservedNetIncome(
      [
        row({ month: "2026-04", sum: "4000.00" }),
        // May is a real gap (a job change), not missing history.
        row({ month: "2026-06", sum: "4000.00" }),
      ],
      WINDOW,
    );

    expect(result.basisMonths).toBe(3); // Apr, May, Jun
    // Median of [4000, 0, 4000] = 4000. Had the leading three zeros counted,
    // the median of six values would have collapsed to 2000.
    expect(result.trailingMedian).toBe("4000.00");
  });

  it("returns a null median when no income was ever observed", () => {
    const result = computeObservedNetIncome([], WINDOW);
    expect(result.trailingMedian).toBeNull();
    expect(result.basisMonths).toBe(0);
    expect(result.windowTotal).toBe("0.00");
  });

  it("nets a clawback within its month rather than clamping it away", () => {
    const result = computeObservedNetIncome(
      [row({ month: "2026-02", sum: "4000.00" }), row({ month: "2026-02", sum: "-500.00" })],
      WINDOW,
    );
    expect(result.monthly.find((m) => m.month === "2026-02")?.amount).toBe("3500.00");
  });
});

// ── The query shape ─────────────────────────────────────────────────────────

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE transactions, categories, category_groups, accounts CASCADE`);
}

beforeEach(reset);

describe("observedNetIncome (query)", () => {
  it("counts income, never transfers or expenses, and reports exclusions", async () => {
    const [account] = await db
      .insert(accounts)
      .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
      .returning({ id: accounts.id });
    if (!account) throw new Error("seed account");

    const [salary] = await db
      .insert(categories)
      .values({ name: "Salary", kind: "income" })
      .returning({ id: categories.id });
    const [refunds] = await db
      .insert(categories)
      .values({ name: "Refunds", kind: "income", excludedFromBaseline: true })
      .returning({ id: categories.id });
    const [rent] = await db
      .insert(categories)
      .values({ name: "Rent", kind: "expense" })
      .returning({ id: categories.id });
    const [xfer] = await db
      .insert(categories)
      .values({ name: "Card Payment", kind: "transfer" })
      .returning({ id: categories.id });
    if (!salary || !refunds || !rent || !xfer) throw new Error("seed categories");

    let fit = 0;
    const txn = (postedAt: string, amount: string, categoryId: string | null) => ({
      accountId: account.id,
      postedAt,
      amount,
      name: "txn",
      fitid: `f${fit++}`,
      source: "manual" as const,
      categoryId,
    });

    await db.insert(transactions).values([
      txn("2026-01-15", "4000.00", salary.id),
      txn("2026-02-15", "4000.00", salary.id),
      // Excluded: fetched and listed, but never counted.
      txn("2026-02-20", "250.00", refunds.id),
      // A transfer INTO checking looks exactly like income at the amount level —
      // `kind` is the only thing keeping it out, so assert it explicitly.
      txn("2026-02-25", "9000.00", xfer.id),
      txn("2026-02-03", "-1800.00", rent.id),
      txn("2026-02-28", "500.00", null),
    ]);

    // A two-month window keeps the median assertion about the FILTERING rather
    // than about trailing zeros (which the pure-core block already covers).
    const result = await observedNetIncome({ from: "2026-01-01", to: "2026-02-28" });

    expect(result.monthly.find((m) => m.month === "2026-01")?.amount).toBe("4000.00");
    // Feb is 4000, not 4250 (refund excluded), not 13000 (transfer excluded),
    // and not 4500 (the uncategorized deposit has no `kind` to qualify it).
    expect(result.monthly.find((m) => m.month === "2026-02")?.amount).toBe("4000.00");
    expect(result.trailingMedian).toBe("4000.00");

    const names = result.contributingCategories.map((c) => c.name);
    expect(names).toContain("Salary");
    expect(names).toContain("Refunds");
    expect(names).not.toContain("Card Payment");
    expect(names).not.toContain("Rent");

    expect(result.contributingCategories.find((c) => c.name === "Refunds")).toMatchObject({
      total: "250.00",
      excluded: true,
    });
  });
});
