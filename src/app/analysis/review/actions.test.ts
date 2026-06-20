// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, categories, categoryRules, transactions } from "@/db/schema/index.ts";
import { matchCategory, sortRules } from "@/lib/categorization/match.ts";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Mocks: requireUser (needs cookies) + next/cache. DB runs for real. */
vi.mock("@/lib/auth/require-user.ts", () => ({
  requireUser: vi.fn(async () => ({
    id: "00000000-0000-0000-0000-000000000001",
    passwordHash: "fake",
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { bulkSetCategoryAction } = await import("./actions.ts");

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE transactions, category_rules, categories, category_groups, accounts CASCADE`,
  );
}

async function seed(): Promise<{ accountId: string; categoryId: string; txnIds: string[] }> {
  const [account] = await db
    .insert(accounts)
    .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account");

  const [cat] = await db
    .insert(categories)
    .values({ name: "Coffee", kind: "expense" })
    .returning({ id: categories.id });
  if (!cat) throw new Error("seed category");

  const inserted = await db
    .insert(transactions)
    .values([
      {
        accountId: account.id,
        postedAt: "2026-05-01",
        amount: "-5.00",
        name: "STARBUCKS #123",
        fitid: "f1",
        source: "manual",
      },
      {
        accountId: account.id,
        postedAt: "2026-05-02",
        amount: "-6.50",
        name: "STARBUCKS #999",
        fitid: "f2",
        source: "manual",
      },
    ])
    .returning({ id: transactions.id });

  return { accountId: account.id, categoryId: cat.id, txnIds: inserted.map((r) => r.id) };
}

beforeEach(reset);
afterEach(() => vi.clearAllMocks());

describe("bulkSetCategoryAction (P8-09)", () => {
  it("categorizes every transaction in the group and stamps the override", async () => {
    const { categoryId, txnIds } = await seed();

    const res = await bulkSetCategoryAction(txnIds, categoryId, { makeRule: false });
    expect(res.ok).toBe(true);
    expect(res.updated).toBe(2);
    expect(res.ruleCreated).toBe(false);

    const rows = await db.select().from(transactions);
    for (const r of rows) {
      expect(r.categoryId).toBe(categoryId);
      expect(r.category).toBe("Coffee");
      expect(r.categoryOverriddenAt).toBeInstanceOf(Date);
    }
    expect(await db.select().from(categoryRules)).toHaveLength(0);
  });

  it("creates exactly one rule from the payee that matches the group", async () => {
    const { categoryId, txnIds } = await seed();

    const res = await bulkSetCategoryAction(txnIds, categoryId, { makeRule: true });
    expect(res.ok).toBe(true);
    expect(res.ruleCreated).toBe(true);

    const rules = await db.select().from(categoryRules);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.categoryId).toBe(categoryId);

    // The derived rule re-matches both raw payee variants (store numbers differ).
    const sorted = sortRules(rules);
    expect(matchCategory("STARBUCKS #123", null, sorted)?.categoryId).toBe(categoryId);
    expect(matchCategory("STARBUCKS #999", null, sorted)?.categoryId).toBe(categoryId);
  });

  it("does not pile up duplicate rules when run twice for the same payee", async () => {
    const { categoryId, txnIds } = await seed();
    await bulkSetCategoryAction(txnIds, categoryId, { makeRule: true });
    const second = await bulkSetCategoryAction(txnIds, categoryId, { makeRule: true });
    expect(second.ruleCreated).toBe(false);
    expect(await db.select().from(categoryRules)).toHaveLength(1);
  });

  it("rejects an empty id list without writing", async () => {
    const { categoryId } = await seed();
    const res = await bulkSetCategoryAction([], categoryId, { makeRule: true });
    expect(res.error).toBeTruthy();
    expect(await db.select().from(categoryRules)).toHaveLength(0);
  });

  it("rejects an unknown category id", async () => {
    const { txnIds } = await seed();
    const res = await bulkSetCategoryAction(txnIds, crypto.randomUUID(), { makeRule: false });
    expect(res.error).toBe("Category not found");
    const [row] = await db
      .select({ categoryId: transactions.categoryId })
      .from(transactions)
      .where(eq(transactions.id, txnIds[0] ?? ""));
    expect(row?.categoryId).toBeNull();
  });
});
