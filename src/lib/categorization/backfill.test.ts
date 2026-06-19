// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accounts,
  categories,
  categoryGroups,
  categoryRules,
  transactions,
} from "@/db/schema/index.ts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { backfillCategories } from "./backfill.ts";

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE transactions, category_rules, categories, category_groups, accounts, import_batches, account_snapshots CASCADE`,
  );
}

async function seedAccount(): Promise<string> {
  const [acc] = await db
    .insert(accounts)
    .values({ name: "Checking", institution: "M&T Bank", type: "depository", currency: "USD" })
    .returning({ id: accounts.id });
  if (!acc) throw new Error("account seed failed");
  return acc.id;
}

async function insertTxn(
  accountId: string,
  fitid: string,
  name: string,
  category: string | null,
): Promise<void> {
  await db.insert(transactions).values({
    accountId,
    postedAt: "2026-01-15",
    amount: "-12.34",
    name,
    category,
    fitid,
    source: "manual",
  });
}

describe("backfillCategories", () => {
  beforeEach(reset);
  afterAll(reset);

  it("links known free-text values to seed categories and parks unknowns under Other", async () => {
    const accountId = await seedAccount();
    await insertTxn(accountId, "a", "STARBUCKS", "Coffee"); // known seed category
    await insertTxn(accountId, "b", "ODD MERCHANT", "Weird Custom"); // unknown
    await insertTxn(accountId, "c", "NO CATEGORY", null); // stays unlinked

    const result = await backfillCategories();

    // Two of the three rows carry a non-null free-text value → two linked.
    expect(result.txnsLinked).toBe(2);
    expect(result.categoriesCreated).toBe(1); // just "Weird Custom"

    // The known value linked to the curated "Coffee" leaf.
    const [coffee] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(sql`lower(${categories.name}) = 'coffee'`)
      .limit(1);
    const [txnA] = await db
      .select({ categoryId: transactions.categoryId })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), eq(transactions.fitid, "a")));
    expect(txnA?.categoryId).toBe(coffee?.id);

    // The unknown value created a leaf under the "Other" group.
    const [other] = await db
      .select({ id: categoryGroups.id })
      .from(categoryGroups)
      .where(sql`lower(${categoryGroups.name}) = 'other'`)
      .limit(1);
    const [weird] = await db
      .select({ groupId: categories.groupId, kind: categories.kind })
      .from(categories)
      .where(sql`lower(${categories.name}) = 'weird custom'`)
      .limit(1);
    expect(weird?.groupId).toBe(other?.id);
    expect(weird?.kind).toBe("expense");

    // The null-category row is left unlinked.
    const [txnC] = await db
      .select({ categoryId: transactions.categoryId })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), eq(transactions.fitid, "c")));
    expect(txnC?.categoryId).toBeNull();
  });

  it("is idempotent — a second run links nothing and creates nothing", async () => {
    const accountId = await seedAccount();
    await insertTxn(accountId, "a", "STARBUCKS", "Coffee");
    await insertTxn(accountId, "b", "ODD MERCHANT", "Weird Custom");

    await backfillCategories();
    const second = await backfillCategories();

    expect(second.txnsLinked).toBe(0);
    expect(second.categoriesCreated).toBe(0);
    expect(second.rulesLinked).toBe(0);

    // No transaction with a non-null category is left unlinked.
    const stragglers = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(sql`${transactions.category} IS NOT NULL`, isNull(transactions.categoryId)));
    expect(stragglers.length).toBe(0);
  });

  it("links a pre-existing legacy rule by name", async () => {
    // A legacy ADR-007 rule present before the structured migration: text only,
    // category_id NULL. Because category_rules is non-empty, the seed skips
    // inserting defaults, and the backfill must link this rule by name.
    await db
      .insert(categoryRules)
      .values({ pattern: "STARBUCKS", category: "Coffee", priority: 21 });

    const result = await backfillCategories();
    expect(result.rulesLinked).toBeGreaterThanOrEqual(1);

    const [rule] = await db
      .select({ categoryId: categoryRules.categoryId })
      .from(categoryRules)
      .where(eq(categoryRules.pattern, "STARBUCKS"))
      .limit(1);
    expect(rule?.categoryId).not.toBeNull();
  });
});
