// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, categoryRules, transactions } from "@/db/schema/index.ts";
import { seedDefaultCategoriesAndRulesIfEmpty } from "@/lib/categorization/seed.ts";
import { REVIEW_QUEUE_TARGET } from "@/lib/help/checklist.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * PLAN20 P20-30 — the checklist's facts, against the real database. Backups
 * come from Redis and the environment, which are mocked: that read is the
 * instance page's, tested there.
 */

vi.mock("@/lib/instance/queries.ts", () => ({ backupsConfigured: vi.fn(async () => null) }));

const { accountFacts, loadBookFacts } = await import("./checklist-facts.ts");

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE transactions, category_rules, categories, category_groups, accounts CASCADE`,
  );
}

async function addTransactions(count: number, categorized: boolean): Promise<void> {
  const [acct] = await db
    .insert(accounts)
    .values({ name: "Checking", institution: "Bank", type: "depository", currency: "USD" })
    .returning({ id: accounts.id });
  if (!acct) throw new Error("seed account");
  const [rule] = await db.select({ categoryId: categoryRules.categoryId }).from(categoryRules);
  await db.insert(transactions).values(
    Array.from({ length: count }, (_, i) => ({
      accountId: acct.id,
      postedAt: "2026-06-01",
      amount: "-1.00",
      name: `payee ${i}`,
      fitid: `f${i}`,
      source: "manual" as const,
      categoryId: categorized ? (rule?.categoryId ?? null) : null,
    })),
  );
}

beforeEach(reset);

describe("loadBookFacts", () => {
  it("reports an empty book", async () => {
    expect(await loadBookFacts()).toEqual({
      hasTransaction: false,
      waitingCount: 0,
      hasOwnRule: false,
      backupsConfigured: null,
    });
  });

  it("does not count the default rules as the owner's own", async () => {
    await seedDefaultCategoriesAndRulesIfEmpty();
    expect((await loadBookFacts()).hasOwnRule).toBe(false);
  });

  it("counts a rule outside the default set", async () => {
    await seedDefaultCategoriesAndRulesIfEmpty();
    await db.insert(categoryRules).values({ pattern: "CORNER BISTRO", category: "Dining" });
    expect((await loadBookFacts()).hasOwnRule).toBe(true);
  });

  it("counts the review queue no higher than the target", async () => {
    await seedDefaultCategoriesAndRulesIfEmpty();
    await addTransactions(REVIEW_QUEUE_TARGET + 5, false);
    const facts = await loadBookFacts();
    expect(facts.hasTransaction).toBe(true);
    expect(facts.waitingCount).toBe(REVIEW_QUEUE_TARGET);
  });

  it("does not count categorized transactions as waiting", async () => {
    await seedDefaultCategoriesAndRulesIfEmpty();
    await addTransactions(3, true);
    expect((await loadBookFacts()).waitingCount).toBe(0);
  });
});

describe("accountFacts", () => {
  it("has no account to import into on a first run", () => {
    expect(accountFacts([])).toEqual({ hasAccount: false, importAccountId: null });
  });

  it("prefers a cash or card account for the import link", () => {
    expect(
      accountFacts([
        { accountId: "brokerage", accountType: "investment" },
        { accountId: "card", accountType: "credit_card" },
      ]),
    ).toEqual({ hasAccount: true, importAccountId: "card" });
  });

  it("falls back to any account", () => {
    expect(accountFacts([{ accountId: "house", accountType: "property" }]).importAccountId).toBe(
      "house",
    );
  });
});
