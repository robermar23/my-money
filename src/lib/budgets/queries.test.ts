// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, categories, categoryGroups, transactions } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { budgetVsActual, listBudgets, monthRange, setBudget } from "./queries.ts";

/* Real DB, like spending.test — these are query functions, nothing to mock. */

interface Seeded {
  groceries: string;
  coffee: string;
  dining: string;
  salary: string;
  transfer: string;
  foodGroup: string;
}

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE transactions, category_budgets, categories, category_groups, accounts CASCADE`,
  );
}

async function seed(): Promise<Seeded> {
  const [acct] = await db
    .insert(accounts)
    .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
    .returning({ id: accounts.id });
  if (!acct) throw new Error("seed account");

  const [food] = await db
    .insert(categoryGroups)
    .values({ name: "Food", sortOrder: 10 })
    .returning({ id: categoryGroups.id });
  const [income] = await db
    .insert(categoryGroups)
    .values({ name: "Income", sortOrder: 1 })
    .returning({ id: categoryGroups.id });
  if (!food || !income) throw new Error("seed groups");

  const [groceries] = await db
    .insert(categories)
    .values({ name: "Groceries", kind: "expense", groupId: food.id, sortOrder: 1 })
    .returning({ id: categories.id });
  const [coffee] = await db
    .insert(categories)
    .values({ name: "Coffee", kind: "expense", groupId: food.id, sortOrder: 2 })
    .returning({ id: categories.id });
  const [dining] = await db
    .insert(categories)
    .values({ name: "Dining", kind: "expense", groupId: food.id, sortOrder: 3 })
    .returning({ id: categories.id });
  const [salary] = await db
    .insert(categories)
    .values({ name: "Salary", kind: "income", groupId: income.id })
    .returning({ id: categories.id });
  const [transfer] = await db
    .insert(categories)
    .values({ name: "Card Payment", kind: "transfer" })
    .returning({ id: categories.id });
  if (!groceries || !coffee || !dining || !salary || !transfer) throw new Error("seed categories");

  let fit = 0;
  const txn = (postedAt: string, amount: string, categoryId: string | null) => ({
    accountId: acct.id,
    postedAt,
    amount,
    name: "txn",
    fitid: `f${fit++}`,
    source: "manual" as const,
    categoryId,
  });

  await db.insert(transactions).values([
    // June (the month under test)
    txn("2026-06-03", "-100.00", groceries.id),
    txn("2026-06-10", "-50.00", groceries.id),
    txn("2026-06-28", "5.00", groceries.id), // refund → net groceries spend 145
    txn("2026-06-12", "-30.00", coffee.id),
    txn("2026-06-15", "-40.00", dining.id), // dining has NO budget
    txn("2026-06-20", "3000.00", salary.id), // income — excluded from expense lines
    txn("2026-06-25", "-500.00", transfer.id), // transfer — excluded entirely
    // A different month — must not leak into June actuals
    txn("2026-05-05", "-999.00", groceries.id),
  ]);

  return {
    groceries: groceries.id,
    coffee: coffee.id,
    dining: dining.id,
    salary: salary.id,
    transfer: transfer.id,
    foodGroup: food.id,
  };
}

beforeEach(reset);

describe("monthRange", () => {
  it("resolves inclusive first/last day, handling month lengths", () => {
    expect(monthRange("2026-06")).toEqual({ from: "2026-06-01", to: "2026-06-30" });
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" }); // leap year
    expect(monthRange("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});

describe("setBudget", () => {
  it("upserts idempotently on category_id (one row, latest amount)", async () => {
    const s = await seed();
    await setBudget(s.groceries, "100.00");
    await setBudget(s.groceries, "120.00");
    const budgets = await listBudgets();
    expect(budgets).toHaveLength(1);
    expect(budgets[0]?.amount).toBe("120.00");
    expect(budgets[0]?.categoryId).toBe(s.groceries);
  });
});

describe("budgetVsActual", () => {
  it("computes actual vs target per category, excluding transfers and income", async () => {
    const s = await seed();
    await setBudget(s.groceries, "120.00");
    await setBudget(s.coffee, "49.99");

    const res = await budgetVsActual("2026-06");
    const byId = new Map(res.lines.map((l) => [l.categoryId, l]));

    // Only the three expense categories — never income or transfer.
    expect(res.lines).toHaveLength(3);
    expect(byId.has(s.salary)).toBe(false);
    expect(byId.has(s.transfer)).toBe(false);

    // Groceries: actual 100 + 50 - 5 = 145, target 120 → over by 25.
    const groceries = byId.get(s.groceries);
    expect(groceries?.actual).toBe("145.00");
    expect(groceries?.target).toBe("120.00");
    expect(groceries?.hasBudget).toBe(true);
    expect(groceries?.remaining).toBe("-25.00"); // penny-exact via Money
    expect(groceries?.pct).toBe(121); // round(145/120*100)

    // Coffee: actual 30, target 49.99 → 19.99 left.
    const coffee = byId.get(s.coffee);
    expect(coffee?.actual).toBe("30.00");
    expect(coffee?.remaining).toBe("19.99");
    expect(coffee?.pct).toBe(60); // round(30/49.99*100)
  });

  it("includes unbudgeted expense categories with a zero target and no divide-by-zero", async () => {
    const s = await seed();
    const res = await budgetVsActual("2026-06");
    const dining = res.lines.find((l) => l.categoryId === s.dining);
    expect(dining?.hasBudget).toBe(false);
    expect(dining?.target).toBe("0.00");
    expect(dining?.actual).toBe("40.00");
    expect(dining?.remaining).toBe("-40.00");
    expect(dining?.pct).toBe(0); // target 0 → guarded, not NaN/Infinity
  });

  it("rolls group totals up as the sum of child targets/actuals", async () => {
    const s = await seed();
    await setBudget(s.groceries, "120.00");
    await setBudget(s.coffee, "50.00");
    // dining unbudgeted (target 0)

    const res = await budgetVsActual("2026-06");
    const food = res.groups.find((g) => g.groupId === s.foodGroup);
    // target 120 + 50 + 0 = 170; actual 145 + 30 + 40 = 215.
    expect(food?.target).toBe("170.00");
    expect(food?.actual).toBe("215.00");
    expect(food?.remaining).toBe("-45.00");

    // Grand totals mirror the only group present.
    expect(res.totals.target).toBe("170.00");
    expect(res.totals.actual).toBe("215.00");
    expect(res.totals.remaining).toBe("-45.00");
  });

  it("scopes actuals to the requested month", async () => {
    const s = await seed();
    // The -999 grocery txn is in May; it must not appear in June actuals.
    const res = await budgetVsActual("2026-06");
    expect(res.lines.find((l) => l.categoryId === s.groceries)?.actual).toBe("145.00");

    const may = await budgetVsActual("2026-05");
    expect(may.lines.find((l) => l.categoryId === s.groceries)?.actual).toBe("999.00");
    expect(may.lines.find((l) => l.categoryId === s.coffee)?.actual).toBe("0.00");
  });
});
