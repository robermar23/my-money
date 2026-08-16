// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, categories, categoryGroups, transactions } from "@/db/schema/index.ts";
import { applyBudgetSuggestionsSchema } from "@/lib/schemas/budget.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { listBudgets, setBudget } from "./queries.ts";
import { applyBudgetSuggestions, previewBudgetSuggestions } from "./suggestions.ts";

/*
 * P15-27 — preview → confirm for budget suggestions. Real DB, like
 * queries.test: these are query functions, and there is nothing to mock.
 *
 * The seed runs March–July 2026 and every test previews at 2026-08-15, so
 * August is an in-progress month the preview must ignore.
 */

const TODAY = "2026-08-15";

interface Seeded {
  groceries: string;
  dining: string;
  coffee: string;
  salary: string;
  transfer: string;
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
  if (!food) throw new Error("seed group");

  const insertCategory = async (name: string, kind: string, groupId?: string) => {
    const [row] = await db
      .insert(categories)
      .values({ name, kind, groupId: groupId ?? null })
      .returning({ id: categories.id });
    if (!row) throw new Error(`seed category ${name}`);
    return row.id;
  };

  const groceries = await insertCategory("Groceries", "expense", food.id);
  const dining = await insertCategory("Dining", "expense", food.id);
  const coffee = await insertCategory("Coffee", "expense", food.id);
  const salary = await insertCategory("Salary", "income");
  const transfer = await insertCategory("Card Payment", "transfer");

  let fit = 0;
  const txn = (postedAt: string, amount: string, categoryId: string) => ({
    accountId: acct.id,
    postedAt,
    amount,
    name: "txn",
    fitid: `f${fit++}`,
    source: "manual" as const,
    categoryId,
  });

  const months = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
  await db.insert(transactions).values([
    ...months.flatMap((month) => [
      txn(`${month}-05`, "-600.00", groceries),
      txn(`${month}-12`, "-250.00", dining),
      txn(`${month}-14`, "-20.00", coffee),
      txn(`${month}-20`, "6000.00", salary),
      txn(`${month}-25`, "-900.00", transfer),
    ]),
    // An in-progress August: a fifth of a month of groceries. Counting it would
    // drag the suggested target down.
    txn("2026-08-04", "-90.00", groceries),
  ]);

  return { groceries, dining, coffee, salary, transfer };
}

beforeEach(reset);

describe("previewBudgetSuggestions", () => {
  it("suggests a target from complete months only", async () => {
    const seeded = await seed();
    const preview = await previewBudgetSuggestions({ today: TODAY });
    const groceries = preview.rows.find((r) => r.categoryId === seeded.groceries);

    expect(preview.monthsConsidered).toBe(5);
    expect(groceries?.suggested).toBe("600.00");
    expect(groceries?.change).toBe("create");
    expect(groceries?.current).toBeNull();
    expect(groceries?.groupName).toBe("Food");
  });

  it("writes nothing — preview is a read", async () => {
    await seed();
    await previewBudgetSuggestions({ today: TODAY });

    // The whole point of the flow: no `category_budgets` row appears until the
    // user confirms.
    expect(await listBudgets()).toHaveLength(0);
  });

  it("marks a stored target that differs as an update, and shows the current one", async () => {
    const seeded = await seed();
    await setBudget(seeded.groceries, "400.00");

    const row = (await previewBudgetSuggestions({ today: TODAY })).rows.find(
      (r) => r.categoryId === seeded.groceries,
    );

    expect(row?.change).toBe("update");
    expect(row?.current).toBe("400.00");
    expect(row?.suggested).toBe("600.00");
    expect(row?.recommended).toBe(true);
  });

  it("does not pre-select a target that already matches", async () => {
    const seeded = await seed();
    await setBudget(seeded.groceries, "600.00");

    const row = (await previewBudgetSuggestions({ today: TODAY })).rows.find(
      (r) => r.categoryId === seeded.groceries,
    );

    // Shown so the user can see it was considered; never ticked by default.
    expect(row?.change).toBe("unchanged");
    expect(row?.recommended).toBe(false);
  });

  it("leaves out categories too small to be worth a target", async () => {
    const seeded = await seed();
    const preview = await previewBudgetSuggestions({ today: TODAY });

    // $20/month Coffee. A preview of thirty rows does not get read.
    expect(preview.rows.map((r) => r.categoryId)).not.toContain(seeded.coffee);
  });

  it("leaves out income and transfer categories", async () => {
    const seeded = await seed();
    const ids = (await previewBudgetSuggestions({ today: TODAY })).rows.map((r) => r.categoryId);

    expect(ids).not.toContain(seeded.salary);
    expect(ids).not.toContain(seeded.transfer);
  });

  it("orders by suggested target and totals only what would change", async () => {
    const seeded = await seed();
    const preview = await previewBudgetSuggestions({ today: TODAY });

    expect(preview.rows.map((r) => r.categoryId)).toEqual([seeded.groceries, seeded.dining]);
    expect(preview.suggestedTotal).toBe("850.00");
  });

  it("carries the observed range so a target can be sanity-checked", async () => {
    const seeded = await seed();
    const row = (await previewBudgetSuggestions({ today: TODAY })).rows.find(
      (r) => r.categoryId === seeded.groceries,
    );

    expect(row?.observedRange).toEqual({ min: "600.00", max: "600.00" });
    expect(row?.basisMonths).toBe(5);
    expect(row?.monthsWithSpend).toBe(5);
  });

  it("returns an empty preview rather than guessing from no history", async () => {
    const preview = await previewBudgetSuggestions({ today: TODAY });

    expect(preview.rows).toEqual([]);
    expect(preview.suggestedTotal).toBe("0.00");
  });
});

describe("applyBudgetSuggestions", () => {
  it("writes exactly the confirmed targets and nothing else", async () => {
    const seeded = await seed();
    const preview = await previewBudgetSuggestions({ today: TODAY });

    // The user unticked Dining.
    const applied = await applyBudgetSuggestions([
      { categoryId: seeded.groceries, amount: "600.00" },
    ]);

    expect(applied).toBe(1);
    const stored = await listBudgets();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.categoryId).toBe(seeded.groceries);
    // Dining was in the preview and is deliberately not in the database.
    expect(preview.rows).toHaveLength(2);
  });

  it("honors an amount the user edited rather than the suggested one", async () => {
    const seeded = await seed();
    await previewBudgetSuggestions({ today: TODAY });

    await applyBudgetSuggestions([{ categoryId: seeded.groceries, amount: "750.00" }]);

    // Re-deriving the list server-side would have written $600 and quietly
    // thrown away the user's edit.
    expect((await listBudgets())[0]?.amount).toBe("750.00");
  });

  it("is idempotent — applying the same targets twice leaves one row", async () => {
    const seeded = await seed();
    const targets = [{ categoryId: seeded.groceries, amount: "600.00" }];

    await applyBudgetSuggestions(targets);
    await applyBudgetSuggestions(targets);

    expect(await listBudgets()).toHaveLength(1);
  });
});

describe("applyBudgetSuggestionsSchema", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";

  it("normalizes amounts to canonical money strings", () => {
    const parsed = applyBudgetSuggestionsSchema.parse({
      targets: [{ categoryId: id, amount: "600" }],
    });

    expect(parsed.targets[0]?.amount).toBe("600.00");
  });

  it("rejects an empty confirmation", () => {
    // An apply that writes nothing must not report success.
    expect(applyBudgetSuggestionsSchema.safeParse({ targets: [] }).success).toBe(false);
  });

  it("rejects the same category twice", () => {
    const result = applyBudgetSuggestionsSchema.safeParse({
      targets: [
        { categoryId: id, amount: "100.00" },
        { categoryId: id, amount: "200.00" },
      ],
    });

    // Which amount wins would depend on upsert order — refuse rather than pick.
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("The same category appears twice");
  });

  it("accepts distinct categories", () => {
    const result = applyBudgetSuggestionsSchema.safeParse({
      targets: [
        { categoryId: id, amount: "100.00" },
        { categoryId: other, amount: "200.00" },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a negative target", () => {
    expect(
      applyBudgetSuggestionsSchema.safeParse({ targets: [{ categoryId: id, amount: "-50.00" }] })
        .success,
    ).toBe(false);
  });

  it("rejects a non-uuid category id", () => {
    expect(
      applyBudgetSuggestionsSchema.safeParse({ targets: [{ categoryId: "nope", amount: "50.00" }] })
        .success,
    ).toBe(false);
  });
});
