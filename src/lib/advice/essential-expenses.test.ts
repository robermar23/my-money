// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, categories, transactions } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type EssentialExpenseRow,
  computeEssentialBaseline,
  essentialMonthlyBaseline,
} from "./essential-expenses.ts";

/*
 * P15-09 — the essential monthly expense baseline (ADR-033 §2, ADR-034 §3).
 *
 * The degenerate all-unclassified case is the most important test in this file:
 * on day one every category is unclassified, and the baseline must report that
 * honestly instead of quietly telling the user their essential spend is $0.
 */

const WINDOW = { from: "2026-01-01", to: "2026-04-30" };

/** Expenses are stored NEGATIVE (OFX outflow); the fold negates them. */
function row(
  month: string,
  bucket: EssentialExpenseRow["bucket"],
  magnitude: string,
): EssentialExpenseRow {
  return { month, bucket, sum: `-${magnitude}` };
}

describe("computeEssentialBaseline", () => {
  it("takes the median of monthly essential spend, not the mean", () => {
    const result = computeEssentialBaseline(
      [
        row("2026-01", "essential", "3000.00"),
        row("2026-02", "essential", "3000.00"),
        row("2026-03", "essential", "3000.00"),
        // One month with a $2,000 furnace replacement classified as essential.
        row("2026-04", "essential", "5000.00"),
      ],
      WINDOW,
    );

    // Median of [3000, 3000, 3000, 5000] = 3000. A mean would say 3,500 and
    // inflate the six-month reserve target by $3,000.
    expect(result.trailingMedian).toBe("3000.00");
    expect(result.baseline).toBe("3000.00");
  });

  it("adds minimum debt service to the baseline", () => {
    const result = computeEssentialBaseline(
      [row("2026-01", "essential", "2000.00"), row("2026-02", "essential", "2000.00")],
      { from: "2026-01-01", to: "2026-02-28" },
      { minimumDebtService: "1450.75" },
    );

    expect(result.trailingMedian).toBe("2000.00");
    expect(result.minimumDebtService).toBe("1450.75");
    // The mortgage is as essential as it gets, but it lives in `liabilities`,
    // not in a spend category — it would be invisible without this.
    expect(result.baseline).toBe("3450.75");
  });

  it("splits a month across all four buckets and totals them", () => {
    const result = computeEssentialBaseline(
      [
        row("2026-01", "essential", "2000.00"),
        row("2026-01", "discretionary", "600.00"),
        row("2026-01", "savings", "400.00"),
        row("2026-01", "unclassified", "300.00"),
      ],
      WINDOW,
    );

    const jan = result.monthly.find((m) => m.month === "2026-01");
    expect(jan).toMatchObject({
      essential: "2000.00",
      discretionary: "600.00",
      savings: "400.00",
      unclassified: "300.00",
      total: "3300.00",
    });
  });

  it("reports the unclassified share so the UI can caveat the estimate", () => {
    const result = computeEssentialBaseline(
      [row("2026-01", "essential", "820.00"), row("2026-01", "unclassified", "180.00")],
      WINDOW,
    );

    expect(result.unclassifiedExpense).toBe("180.00");
    expect(result.totalExpense).toBe("1000.00");
    expect(result.unclassifiedShare).toBe(0.18);
  });

  it("degenerates honestly when NOTHING is classified — the day-one state", () => {
    const result = computeEssentialBaseline(
      [
        row("2026-01", "unclassified", "3000.00"),
        row("2026-02", "unclassified", "3200.00"),
        row("2026-03", "unclassified", "2900.00"),
      ],
      WINDOW,
    );

    // We looked and found no essential spend — that is a real answer, and it is
    // distinguishable from "there were no months to look at" (null).
    expect(result.trailingMedian).toBe("0.00");
    expect(result.baseline).toBe("0.00");
    // ...and the share is 100%, which is what makes the zero readable rather
    // than misleading. The UI is obliged to say so (P15-31).
    expect(result.unclassifiedShare).toBe(1);
    // April is inside the window and had no activity — a real trailing zero
    // month, kept (only LEADING empties are trimmed).
    expect(result.basisMonths).toBe(4);
  });

  it("returns a null median and baseline when there is no expense history at all", () => {
    const result = computeEssentialBaseline([], WINDOW, { minimumDebtService: "900.00" });

    // Null even though debt service IS known: a reserve target built on zero
    // months of spend history is the confident wrong number ADR-032 prevents.
    expect(result.trailingMedian).toBeNull();
    expect(result.baseline).toBeNull();
    expect(result.basisMonths).toBe(0);
    expect(result.unclassifiedShare).toBe(0); // not NaN
  });

  it("trims leading months with no activity but keeps interior zero months", () => {
    const result = computeEssentialBaseline(
      [
        // History starts in March.
        row("2026-03", "essential", "2000.00"),
        // April had only discretionary spend — essential really was zero, and
        // dropping the month would bias the median upward.
        row("2026-04", "discretionary", "500.00"),
      ],
      WINDOW,
    );

    expect(result.basisMonths).toBe(2);
    expect(result.trailingMedian).toBe("1000.00"); // median of [2000, 0]
  });
});

// ── The query shape ─────────────────────────────────────────────────────────

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE transactions, categories, category_groups, accounts CASCADE`);
}

beforeEach(reset);

describe("essentialMonthlyBaseline (query)", () => {
  it("buckets by necessity, counts uncategorized outflow as unclassified, ignores transfers", async () => {
    const [account] = await db
      .insert(accounts)
      .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
      .returning({ id: accounts.id });
    if (!account) throw new Error("seed account");

    const [rent] = await db
      .insert(categories)
      .values({ name: "Rent", kind: "expense", necessity: "essential" })
      .returning({ id: categories.id });
    const [dining] = await db
      .insert(categories)
      .values({ name: "Dining", kind: "expense", necessity: "discretionary" })
      .returning({ id: categories.id });
    const [misc] = await db
      .insert(categories)
      .values({ name: "Misc", kind: "expense" }) // necessity IS NULL
      .returning({ id: categories.id });
    const [salary] = await db
      .insert(categories)
      .values({ name: "Salary", kind: "income" })
      .returning({ id: categories.id });
    const [xfer] = await db
      .insert(categories)
      .values({ name: "Card Payment", kind: "transfer" })
      .returning({ id: categories.id });
    if (!rent || !dining || !misc || !salary || !xfer) throw new Error("seed categories");

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
      txn("2026-01-01", "-1800.00", rent.id),
      txn("2026-01-05", "-200.00", dining.id),
      txn("2026-01-09", "-100.00", misc.id),
      // No category at all — the app's other blind spot, equally invisible.
      txn("2026-01-12", "-150.00", null),
      // An uncategorized DEPOSIT is not spend and must not net against it.
      txn("2026-01-14", "600.00", null),
      // Neither of these is an expense.
      txn("2026-01-20", "4000.00", salary.id),
      txn("2026-01-25", "-900.00", xfer.id),
    ]);

    const result = await essentialMonthlyBaseline({ from: "2026-01-01", to: "2026-01-31" });

    const jan = result.monthly.find((m) => m.month === "2026-01");
    expect(jan).toMatchObject({
      essential: "1800.00",
      discretionary: "200.00",
      savings: "0.00",
      // 100 (necessity NULL) + 150 (no category), NOT netted by the 600 deposit.
      unclassified: "250.00",
      total: "2250.00",
    });

    expect(result.trailingMedian).toBe("1800.00");
    expect(result.unclassifiedShare).toBeCloseTo(250 / 2250, 4);
  });
});
