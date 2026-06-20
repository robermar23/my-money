// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, categories, categoryRules, transactions } from "@/db/schema/index.ts";
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

const { createRuleAction, updateRuleAction, recategorizeAllAction } = await import("./actions.ts");

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE accounts, transactions, categories, category_groups, category_rules CASCADE`,
  );
});
afterEach(() => vi.clearAllMocks());

describe("updateRuleAction (P7-15 / P7-16)", () => {
  it("changes the rule's category and a re-run reflects it", async () => {
    const [coffee] = await db
      .insert(categories)
      .values({ name: "Coffee", kind: "expense" })
      .returning({ id: categories.id });
    const [dining] = await db
      .insert(categories)
      .values({ name: "Dining", kind: "expense" })
      .returning({ id: categories.id });
    if (!coffee || !dining) throw new Error("seed categories");

    const [account] = await db
      .insert(accounts)
      .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
      .returning({ id: accounts.id });
    if (!account) throw new Error("seed account");
    const [txn] = await db
      .insert(transactions)
      .values({
        accountId: account.id,
        postedAt: "2026-05-01",
        amount: "-5.00",
        name: "STARBUCKS #123",
        fitid: "f1",
        source: "manual",
      })
      .returning({ id: transactions.id });
    if (!txn) throw new Error("seed txn");

    // Create a rule → Coffee, then recategorize.
    const created = await createRuleAction(
      {},
      form({
        pattern: "STARBUCKS",
        flags: "i",
        field: "name",
        categoryId: coffee.id,
        priority: "100",
      }),
    );
    expect(created.ok).toBe(true);
    await recategorizeAllAction();
    let [row] = await db.select().from(transactions).where(eq(transactions.id, txn.id));
    expect(row?.category).toBe("Coffee");

    // Re-point the rule to Dining, then recategorize again.
    const [rule] = await db.select().from(categoryRules);
    if (!rule) throw new Error("expected a rule");
    const updated = await updateRuleAction(
      {},
      form({
        id: rule.id,
        pattern: "STARBUCKS",
        flags: "i",
        field: "name",
        categoryId: dining.id,
        priority: "100",
      }),
    );
    expect(updated.ok).toBe(true);

    await recategorizeAllAction();
    [row] = await db.select().from(transactions).where(eq(transactions.id, txn.id));
    expect(row?.category).toBe("Dining");
    expect(row?.categoryId).toBe(dining.id);
  });

  it("rejects an invalid regex without writing", async () => {
    const [coffee] = await db
      .insert(categories)
      .values({ name: "Coffee", kind: "expense" })
      .returning({ id: categories.id });
    if (!coffee) throw new Error("seed category");
    await createRuleAction(
      {},
      form({
        pattern: "STARBUCKS",
        flags: "i",
        field: "name",
        categoryId: coffee.id,
        priority: "100",
      }),
    );
    const [rule] = await db.select().from(categoryRules);
    if (!rule) throw new Error("expected a rule");

    const res = await updateRuleAction(
      {},
      form({
        id: rule.id,
        pattern: "(unclosed",
        flags: "i",
        field: "name",
        categoryId: coffee.id,
        priority: "100",
      }),
    );
    expect(res.error).toMatch(/regex/i);
    const [unchanged] = await db.select().from(categoryRules).where(eq(categoryRules.id, rule.id));
    expect(unchanged?.pattern).toBe("STARBUCKS");
  });
});
