// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  categories,
  categoryRules,
  holdingLots,
  holdings,
  liabilities,
  plaidItems,
  transactions,
} from "@/db/schema/index.ts";
import { matchCategory, sortRules } from "@/lib/categorization/match.ts";
import { computeNetWorth } from "@/lib/net-worth/compute.ts";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

/* ---------------------------------------------------------------------------
 * Mocks: requireUser (needs cookies) + next/cache. DB runs for real.
 * --------------------------------------------------------------------------- */

vi.mock("@/lib/auth/require-user.ts", () => ({
  requireUser: vi.fn(async () => ({
    id: "00000000-0000-0000-0000-000000000001",
    passwordHash: "fake",
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const {
  addLotAction,
  deleteLotAction,
  updateAccountAction,
  closeAccountAction,
  reopenAccountAction,
  deleteAccountAction,
  setTransactionCategoryAction,
} = await import("./actions.ts");

async function seedHolding(): Promise<{ accountId: string; holdingId: string }> {
  await db.execute(sql`TRUNCATE accounts, holdings, holding_lots CASCADE`);
  const [account] = await db
    .insert(accounts)
    .values({ name: "Fidelity", institution: "Fidelity", type: "investment", currency: "USD" })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account");
  const [holding] = await db
    .insert(holdings)
    .values({
      accountId: account.id,
      symbol: "AAPL",
      quantity: "10",
      quantityUnit: "shares",
      assetClass: "equity",
      source: "manual",
    })
    .returning({ id: holdings.id });
  if (!holding) throw new Error("seed holding");
  return { accountId: account.id, holdingId: holding.id };
}

function lotForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

afterEach(() => vi.clearAllMocks());

describe("addLotAction (P5-18)", () => {
  it("inserts a manual lot and stamps the holding's cost_basis_overridden_at", async () => {
    const { accountId, holdingId } = await seedHolding();

    const result = await addLotAction(
      accountId,
      holdingId,
      {},
      lotForm({ acquiredAt: "2026-01-15", quantity: "10", costBasisTotal: "1000.00" }),
    );
    expect(result.ok).toBe(true);

    const lots = await db.select().from(holdingLots).where(eq(holdingLots.holdingId, holdingId));
    expect(lots).toHaveLength(1);
    expect(lots[0]?.costBasisTotal).toBe("1000.00");
    expect(lots[0]?.acquiredAt).toBe("2026-01-15");
    expect(lots[0]?.source).toBe("manual");

    const [h] = await db.select().from(holdings).where(eq(holdings.id, holdingId));
    expect(h?.costBasisOverriddenAt).toBeInstanceOf(Date);
  });

  it("rejects a malformed holding id without writing", async () => {
    const { accountId } = await seedHolding();
    const result = await addLotAction(
      accountId,
      "not-a-uuid",
      {},
      lotForm({ quantity: "1", costBasisTotal: "1.00" }),
    );
    expect(result.error).toBeTruthy();
    expect(await db.select().from(holdingLots)).toHaveLength(0);
  });

  it("rejects an invalid quantity", async () => {
    const { accountId, holdingId } = await seedHolding();
    const result = await addLotAction(
      accountId,
      holdingId,
      {},
      lotForm({ quantity: "abc", costBasisTotal: "1.00" }),
    );
    expect(result.error).toBeTruthy();
    expect(await db.select().from(holdingLots)).toHaveLength(0);
  });
});

describe("deleteLotAction (P5-18)", () => {
  it("removes a lot belonging to the holding", async () => {
    const { accountId, holdingId } = await seedHolding();
    await addLotAction(
      accountId,
      holdingId,
      {},
      lotForm({ quantity: "10", costBasisTotal: "1000.00" }),
    );
    const [lot] = await db.select().from(holdingLots).where(eq(holdingLots.holdingId, holdingId));
    if (!lot) throw new Error("expected a lot");

    const result = await deleteLotAction(accountId, holdingId, lot.id);
    expect(result.ok).toBe(true);
    expect(
      await db.select().from(holdingLots).where(eq(holdingLots.holdingId, holdingId)),
    ).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------
 * Phase 7 — Batch 1: account management (edit / close / delete).
 * --------------------------------------------------------------------------- */

async function resetAll(): Promise<void> {
  await db.execute(
    sql`TRUNCATE accounts, holdings, holding_lots, account_snapshots, transactions, liabilities, plaid_items CASCADE`,
  );
}

async function seedAccount(): Promise<string> {
  await resetAll();
  const [account] = await db
    .insert(accounts)
    .values({ name: "M&T Checking", institution: "M&T Bank", type: "depository", currency: "USD" })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account");
  return account.id;
}

function accountForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("updateAccountAction (P7-01)", () => {
  it("applies name and institution", async () => {
    const accountId = await seedAccount();
    const res = await updateAccountAction(
      accountId,
      {},
      accountForm({
        name: "Renamed",
        institution: "M&T",
        type: "depository",
        currency: "USD",
      }),
    );
    expect(res.ok).toBe(true);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(a?.name).toBe("Renamed");
    expect(a?.institution).toBe("M&T");
  });

  it("applies type and currency when the account has no data", async () => {
    const accountId = await seedAccount();
    const res = await updateAccountAction(
      accountId,
      {},
      accountForm({
        name: "M&T Checking",
        institution: "M&T Bank",
        type: "credit_card",
        currency: "EUR",
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.note).toBeUndefined();
    const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(a?.type).toBe("credit_card");
    expect(a?.currency).toBe("EUR");
  });

  it("locks type and currency once the account has data, but still applies name", async () => {
    const accountId = await seedAccount();
    await db.insert(accountSnapshots).values({ accountId, date: "2026-05-01", balance: "100.00" });

    const res = await updateAccountAction(
      accountId,
      {},
      accountForm({
        name: "New Name",
        institution: "M&T Bank",
        type: "credit_card",
        currency: "EUR",
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.note).toBeTruthy();
    const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(a?.name).toBe("New Name");
    expect(a?.type).toBe("depository");
    expect(a?.currency).toBe("USD");
  });
});

describe("closeAccountAction / reopenAccountAction (P7-02)", () => {
  it("close removes the account from computeNetWorth; reopen restores it", async () => {
    const accountId = await seedAccount();
    await db.insert(accountSnapshots).values({ accountId, date: "2026-05-01", balance: "5000.00" });

    const before = await computeNetWorth();
    expect(before.total.toString()).toBe("5000.00");

    await closeAccountAction(accountId);
    const afterClose = await computeNetWorth();
    expect(afterClose.total.toString()).toBe("0.00");
    expect(afterClose.items).toHaveLength(0);

    await reopenAccountAction(accountId);
    const afterReopen = await computeNetWorth();
    expect(afterReopen.total.toString()).toBe("5000.00");
  });
});

describe("deleteAccountAction (P7-03)", () => {
  it("cascades all child rows and removes the account", async () => {
    const accountId = await seedAccount();
    await db.insert(accountSnapshots).values({ accountId, date: "2026-05-01", balance: "100.00" });
    const [holding] = await db
      .insert(holdings)
      .values({
        accountId,
        symbol: "AAPL",
        quantity: "10",
        quantityUnit: "shares",
        assetClass: "equity",
        source: "manual",
      })
      .returning({ id: holdings.id });
    if (!holding) throw new Error("seed holding");
    await db.insert(holdingLots).values({
      holdingId: holding.id,
      quantity: "10",
      costBasisTotal: "1000.00",
      source: "manual",
    });
    await db.insert(transactions).values({
      accountId,
      postedAt: "2026-05-01",
      amount: "-12.34",
      name: "Coffee",
      fitid: "fit-1",
      source: "manual",
    });
    await db.insert(liabilities).values({
      accountId,
      name: "Loan",
      principalAtOrigination: "1000.00",
      annualRate: "0.05",
      termMonths: 12,
      startDate: "2026-01-01",
    });

    // Success path redirects (throws NEXT_REDIRECT); the delete commits first.
    await deleteAccountAction(accountId).catch(() => undefined);

    expect(await db.select().from(accounts).where(eq(accounts.id, accountId))).toHaveLength(0);
    expect(await db.select().from(holdings)).toHaveLength(0);
    expect(await db.select().from(holdingLots)).toHaveLength(0);
    expect(await db.select().from(accountSnapshots)).toHaveLength(0);
    expect(await db.select().from(transactions)).toHaveLength(0);
    expect(await db.select().from(liabilities)).toHaveLength(0);
  });

  it("is blocked for a Plaid-linked account", async () => {
    await resetAll();
    const [item] = await db
      .insert(plaidItems)
      .values({
        plaidItemId: "item-1",
        institutionId: "ins_1",
        institutionName: "M&T Bank",
        productsConsented: ["transactions"],
      })
      .returning({ id: plaidItems.id });
    if (!item) throw new Error("seed item");
    const [account] = await db
      .insert(accounts)
      .values({
        name: "M&T Checking",
        institution: "M&T Bank",
        type: "depository",
        currency: "USD",
        plaidItemId: item.id,
      })
      .returning({ id: accounts.id });
    if (!account) throw new Error("seed account");

    const res = await deleteAccountAction(account.id);
    expect(res.error).toBeTruthy();
    expect(await db.select().from(accounts).where(eq(accounts.id, account.id))).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------------------
 * Phase 8 — Batch 2: inline category assignment (P8-08).
 * --------------------------------------------------------------------------- */

async function seedTxnForCategorize(): Promise<{
  accountId: string;
  categoryId: string;
  txnId: string;
}> {
  await db.execute(
    sql`TRUNCATE accounts, transactions, categories, category_groups, category_rules CASCADE`,
  );
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
  return { accountId: account.id, categoryId: cat.id, txnId: txn.id };
}

describe("setTransactionCategoryAction (P8-08)", () => {
  it("sets categoryId + the text cache and stamps the override", async () => {
    const { accountId, categoryId, txnId } = await seedTxnForCategorize();
    const res = await setTransactionCategoryAction(accountId, txnId, categoryId);
    expect(res.ok).toBe(true);

    const [row] = await db.select().from(transactions).where(eq(transactions.id, txnId));
    expect(row?.categoryId).toBe(categoryId);
    expect(row?.category).toBe("Coffee");
    expect(row?.categoryOverriddenAt).toBeInstanceOf(Date);
    expect(await db.select().from(categoryRules)).toHaveLength(0);
  });

  it("optionally creates a rule from the payee that re-matches the merchant", async () => {
    const { accountId, categoryId, txnId } = await seedTxnForCategorize();
    await setTransactionCategoryAction(accountId, txnId, categoryId, { makeRule: true });

    const rules = await db.select().from(categoryRules);
    expect(rules).toHaveLength(1);
    expect(matchCategory("STARBUCKS #777", null, sortRules(rules))?.categoryId).toBe(categoryId);
  });

  it("clears the category when passed null", async () => {
    const { accountId, categoryId, txnId } = await seedTxnForCategorize();
    await setTransactionCategoryAction(accountId, txnId, categoryId);
    const res = await setTransactionCategoryAction(accountId, txnId, null);
    expect(res.ok).toBe(true);
    const [row] = await db.select().from(transactions).where(eq(transactions.id, txnId));
    expect(row?.categoryId).toBeNull();
    expect(row?.category).toBeNull();
  });

  it("rejects an unknown category id without writing", async () => {
    const { accountId, txnId } = await seedTxnForCategorize();
    const res = await setTransactionCategoryAction(accountId, txnId, crypto.randomUUID());
    expect(res.error).toBe("Category not found");
    const [row] = await db.select().from(transactions).where(eq(transactions.id, txnId));
    expect(row?.categoryId).toBeNull();
  });
});
