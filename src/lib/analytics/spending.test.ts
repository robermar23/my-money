// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, categories, categoryGroups, transactions } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { categoryDetail, spendByCategory, spendByMonth, spendingSummary } from "./spending.ts";

/* Real DB; no auth/cache to mock — these are pure query functions. */

interface Seeded {
  acctA: string;
  acctB: string;
  groceries: string;
  coffee: string;
  salary: string;
  transfer: string;
}

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE transactions, categories, category_groups, accounts CASCADE`);
}

async function seed(): Promise<Seeded> {
  const [acctA] = await db
    .insert(accounts)
    .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
    .returning({ id: accounts.id });
  const [acctB] = await db
    .insert(accounts)
    .values({ name: "Card", institution: "Citi", type: "credit_card", currency: "USD" })
    .returning({ id: accounts.id });
  if (!acctA || !acctB) throw new Error("seed accounts");

  const [food] = await db
    .insert(categoryGroups)
    .values({ name: "Food", sortOrder: 10 })
    .returning({ id: categoryGroups.id });
  const [incomeGroup] = await db
    .insert(categoryGroups)
    .values({ name: "Income", sortOrder: 1 })
    .returning({ id: categoryGroups.id });
  if (!food || !incomeGroup) throw new Error("seed groups");

  const [groceries] = await db
    .insert(categories)
    .values({ name: "Groceries", kind: "expense", groupId: food.id })
    .returning({ id: categories.id });
  const [coffee] = await db
    .insert(categories)
    .values({ name: "Coffee", kind: "expense", groupId: food.id })
    .returning({ id: categories.id });
  const [salary] = await db
    .insert(categories)
    .values({ name: "Salary", kind: "income", groupId: incomeGroup.id })
    .returning({ id: categories.id });
  const [transfer] = await db
    .insert(categories)
    .values({ name: "Card Payment", kind: "transfer" })
    .returning({ id: categories.id });
  if (!groceries || !coffee || !salary || !transfer) throw new Error("seed categories");

  let fit = 0;
  const txn = (accountId: string, postedAt: string, amount: string, categoryId: string | null) => ({
    accountId,
    postedAt,
    amount,
    name: "txn",
    fitid: `f${fit++}`,
    source: "manual" as const,
    categoryId,
  });

  await db.insert(transactions).values([
    // May: groceries -100 (A), coffee -20 (A), salary +3000 (A)
    txn(acctA.id, "2026-05-03", "-100.00", groceries.id),
    txn(acctA.id, "2026-05-10", "-20.00", coffee.id),
    txn(acctA.id, "2026-05-31", "3000.00", salary.id),
    // June: groceries -50 (A), groceries -30 (B), coffee -10 (B), transfer -500 (B)
    txn(acctA.id, "2026-06-01", "-50.00", groceries.id),
    txn(acctB.id, "2026-06-15", "-30.00", groceries.id),
    txn(acctB.id, "2026-06-20", "-10.00", coffee.id),
    txn(acctB.id, "2026-06-25", "-500.00", transfer.id),
    // June: a grocery refund +5 (A) — net reduces grocery spend
    txn(acctA.id, "2026-06-28", "5.00", groceries.id),
    // Uncategorized outflow in June (A)
    txn(acctA.id, "2026-06-29", "-40.00", null),
  ]);

  return {
    acctA: acctA.id,
    acctB: acctB.id,
    groceries: groceries.id,
    coffee: coffee.id,
    salary: salary.id,
    transfer: transfer.id,
  };
}

const RANGE = { from: "2026-05-01", to: "2026-06-30" };

beforeEach(reset);

describe("spendByCategory", () => {
  it("returns positive spend magnitudes per expense category and excludes transfers", async () => {
    const s = await seed();
    const rows = await spendByCategory(RANGE);

    const byId = new Map(rows.map((r) => [r.id, r]));
    // Groceries: 100 + 50 + 30 - 5 (refund) = 175
    expect(byId.get(s.groceries)?.total).toBe("175.00");
    // Coffee: 20 + 10 = 30
    expect(byId.get(s.coffee)?.total).toBe("30.00");
    // Salary income magnitude = 3000
    expect(byId.get(s.salary)?.total).toBe("3000.00");
    expect(byId.get(s.salary)?.kind).toBe("income");
    // Transfer category never appears.
    expect(byId.has(s.transfer)).toBe(false);
  });

  it("sorts by magnitude descending", async () => {
    await seed();
    const rows = await spendByCategory(RANGE);
    // Salary (3000) > Groceries (175) > Coffee (30)
    expect(rows.map((r) => r.name)).toEqual(["Salary", "Groceries", "Coffee"]);
  });

  it("filters by account", async () => {
    const s = await seed();
    const rows = await spendByCategory({ ...RANGE, accountIds: [s.acctB] });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Account B only: groceries 30, coffee 10, no salary.
    expect(byId.get(s.groceries)?.total).toBe("30.00");
    expect(byId.get(s.coffee)?.total).toBe("10.00");
    expect(byId.has(s.salary)).toBe(false);
  });

  it("rolls up to groups", async () => {
    await seed();
    const rows = await spendByCategory({ ...RANGE, groupBy: "group" });
    const byName = new Map(rows.map((r) => [r.name, r]));
    // Food group = groceries 175 + coffee 30 = 205
    expect(byName.get("Food")?.total).toBe("205.00");
    expect(byName.get("Food")?.kind).toBe("expense");
    // Income group = 3000
    expect(byName.get("Income")?.total).toBe("3000.00");
    expect(byName.get("Income")?.kind).toBe("income");
  });

  it("returns empty for a range with no transactions", async () => {
    await seed();
    const rows = await spendByCategory({ from: "2020-01-01", to: "2020-12-31" });
    expect(rows).toEqual([]);
  });
});

describe("spendByMonth", () => {
  it("buckets income/expense by month with a gap-free series", async () => {
    await seed();
    const months = await spendByMonth(RANGE);
    expect(months.map((m) => m.month)).toEqual(["2026-05", "2026-06"]);

    const may = months[0];
    const jun = months[1];
    // May: expense 100 + 20 = 120, income 3000, net 2880
    expect(may?.expense).toBe("120.00");
    expect(may?.income).toBe("3000.00");
    expect(may?.net).toBe("2880.00");
    // June: expense 50 + 30 + 10 - 5 = 85, income 0, net -85 (transfer excluded)
    expect(jun?.expense).toBe("85.00");
    expect(jun?.income).toBe("0.00");
    expect(jun?.net).toBe("-85.00");
  });

  it("emits zero-filled months across the whole range (no NaN on empty months)", async () => {
    await seed();
    const months = await spendByMonth({ from: "2026-03-01", to: "2026-06-30" });
    expect(months.map((m) => m.month)).toEqual(["2026-03", "2026-04", "2026-05", "2026-06"]);
    expect(months[0]).toMatchObject({ income: "0.00", expense: "0.00", net: "0.00" });
    expect(months[0]?.byCategory).toEqual({});
  });

  it("breaks expense down by category id", async () => {
    const s = await seed();
    const months = await spendByMonth(RANGE);
    const jun = months[1];
    expect(jun?.byCategory[s.groceries]).toBe("75.00"); // 50 + 30 - 5
    expect(jun?.byCategory[s.coffee]).toBe("10.00");
    // Transfers + income are not in the per-category expense breakdown.
    expect(jun?.byCategory[s.salary]).toBeUndefined();
    expect(jun?.byCategory[s.transfer]).toBeUndefined();
  });
});

describe("spendingSummary", () => {
  it("totals income/expense/net and counts uncategorized outflow", async () => {
    await seed();
    const sum = await spendingSummary(RANGE);
    // expense = 120 (May) + 85 (June) = 205; income 3000; net 2795
    expect(sum.expense).toBe("205.00");
    expect(sum.income).toBe("3000.00");
    expect(sum.net).toBe("2795.00");
    // One uncategorized outflow of -40 in June.
    expect(sum.uncategorizedCount).toBe(1);
    expect(sum.uncategorizedOutflow).toBe("40.00");
  });
});

describe("categoryDetail", () => {
  it("returns a gap-free monthly magnitude series and range total", async () => {
    const s = await seed();
    const detail = await categoryDetail(s.groceries, { from: "2026-04-01", to: "2026-06-30" });
    expect(detail.category?.name).toBe("Groceries");
    expect(detail.monthly.map((m) => m.month)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(detail.monthly).toEqual([
      { month: "2026-04", total: "0.00" },
      { month: "2026-05", total: "100.00" },
      { month: "2026-06", total: "75.00" },
    ]);
    expect(detail.total).toBe("175.00");
  });

  it("returns category: null for an unknown id", async () => {
    await seed();
    const detail = await categoryDetail(crypto.randomUUID(), RANGE);
    expect(detail.category).toBeNull();
    expect(detail.monthly).toEqual([]);
  });
});
