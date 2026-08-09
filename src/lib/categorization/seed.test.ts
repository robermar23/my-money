// @vitest-environment node
import { db } from "@/db/client.ts";
import { categories, categoryGroups, categoryRules } from "@/db/schema/index.ts";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { seedDefaultCategoriesAndRulesIfEmpty } from "./seed.ts";

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE transactions, category_rules, categories, category_groups, accounts, import_batches, account_snapshots CASCADE`,
  );
}

describe("seedDefaultCategoriesAndRulesIfEmpty", () => {
  beforeEach(reset);
  afterAll(reset);

  it("inserts groups, categories, and rules on first run and is a no-op thereafter", async () => {
    const first = await seedDefaultCategoriesAndRulesIfEmpty();
    expect(first.groupsInserted).toBeGreaterThan(0);
    expect(first.categoriesInserted).toBeGreaterThan(0);
    expect(first.rulesInserted).toBeGreaterThan(0);

    const second = await seedDefaultCategoriesAndRulesIfEmpty();
    expect(second).toEqual({ groupsInserted: 0, categoriesInserted: 0, rulesInserted: 0 });

    const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(categories);
    expect(countRows[0]?.count).toBe(first.categoriesInserted);
  });

  it("links every seeded rule to a real category id", async () => {
    await seedDefaultCategoriesAndRulesIfEmpty();
    const rules = await db.select().from(categoryRules);
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.categoryId).not.toBeNull();
    }

    const ruleCatIds = [...new Set(rules.map((r) => r.categoryId as string))];
    const cats = await db
      .select({ id: categories.id })
      .from(categories)
      .where(inArray(categories.id, ruleCatIds));
    expect(cats.length).toBe(ruleCatIds.length);
  });

  it("assigns kind='transfer' to transfer / payment / P2P categories", async () => {
    await seedDefaultCategoriesAndRulesIfEmpty();
    const transferNames = ["Transfer", "Payment", "Credit Card Payment", "P2P Transfer"];
    const rows = await db
      .select({ name: categories.name, kind: categories.kind })
      .from(categories)
      .where(inArray(categories.name, transferNames));
    expect(rows.length).toBe(transferNames.length);
    for (const row of rows) {
      expect(row.kind).toBe("transfer");
    }
  });

  it("groups every category under a real group", async () => {
    await seedDefaultCategoriesAndRulesIfEmpty();
    const groups = await db.select({ id: categoryGroups.id }).from(categoryGroups);
    const groupIds = new Set(groups.map((g) => g.id));
    const cats = await db.select({ groupId: categories.groupId }).from(categories);
    for (const c of cats) {
      expect(c.groupId).not.toBeNull();
      expect(groupIds.has(c.groupId as string)).toBe(true);
    }
  });
});
