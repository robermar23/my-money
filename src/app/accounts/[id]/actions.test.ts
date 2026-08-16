// @vitest-environment node
import { db } from "@/db/client.ts";
import type { NewAccount } from "@/db/schema/index.ts";
import {
  accountSnapshots,
  accounts,
  assetDocuments,
  categories,
  categoryRules,
  creditLines,
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
  recordAssetValueAction,
  updateAssetMetadataAction,
  uploadAssetDocumentAction,
  deleteAssetDocumentAction,
  updateAccountTermsAction,
  saveCreditLineTermsAction,
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

/* ---------------------------------------------------------------------------
 * Phase 10 — Batch 2: personal-asset value + metadata (P10-05 / P10-06).
 * --------------------------------------------------------------------------- */

async function seedAsset(): Promise<string> {
  await resetAll();
  const [account] = await db
    .insert(accounts)
    .values({
      name: "2021 Tacoma",
      institution: "Personal asset",
      type: "personal_asset",
      currency: "USD",
      assetCategory: "vehicle",
      acquisitionCost: "38000.00",
    })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed asset");
  return account.id;
}

describe("recordAssetValueAction (P10-05)", () => {
  it("inserts a snapshot, then overwrites it on the same date (idempotent)", async () => {
    const accountId = await seedAsset();

    const first = await recordAssetValueAction(
      accountId,
      {},
      accountForm({ date: "2026-06-20", value: "35000.00" }),
    );
    expect(first.ok).toBe(true);

    const second = await recordAssetValueAction(
      accountId,
      {},
      accountForm({ date: "2026-06-20", value: "34000.00" }),
    );
    expect(second.ok).toBe(true);

    const snaps = await db
      .select()
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, accountId));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.balance).toBe("34000.00");
  });

  it("rejects a non-asset account type", async () => {
    const accountId = await seedAccount(); // depository
    const res = await recordAssetValueAction(
      accountId,
      {},
      accountForm({ date: "2026-06-20", value: "100.00" }),
    );
    expect(res.error).toBeTruthy();
    expect(await db.select().from(accountSnapshots)).toHaveLength(0);
  });
});

describe("updateAssetMetadataAction (P10-06)", () => {
  it("updates name, category, description, acquired date, and cost", async () => {
    const accountId = await seedAsset();
    const res = await updateAssetMetadataAction(
      accountId,
      {},
      accountForm({
        name: "2021 Tacoma TRD",
        assetCategory: "vehicle",
        description: "Repainted 2026",
        acquiredAt: "2021-03-10",
        acquisitionCost: "37500.00",
      }),
    );
    expect(res.ok).toBe(true);

    const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(a?.name).toBe("2021 Tacoma TRD");
    expect(a?.description).toBe("Repainted 2026");
    expect(a?.acquiredAt).toBe("2021-03-10");
    expect(a?.acquisitionCost).toBe("37500.00");
  });

  it("clears optional fields when submitted empty", async () => {
    const accountId = await seedAsset();
    const res = await updateAssetMetadataAction(
      accountId,
      {},
      accountForm({
        name: "Tacoma",
        assetCategory: "other",
        description: "",
        acquiredAt: "",
        acquisitionCost: "",
      }),
    );
    expect(res.ok).toBe(true);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(a?.assetCategory).toBe("other");
    expect(a?.description).toBeNull();
    expect(a?.acquiredAt).toBeNull();
    expect(a?.acquisitionCost).toBeNull();
  });

  it("rejects a non-asset account type", async () => {
    const accountId = await seedAccount(); // depository
    const res = await updateAssetMetadataAction(
      accountId,
      {},
      accountForm({ name: "x", assetCategory: "vehicle" }),
    );
    expect(res.error).toBeTruthy();
  });
});

/* ---------------------------------------------------------------------------
 * Phase 10 — Batch 3: proof-of-authenticity documents (P10-09).
 * --------------------------------------------------------------------------- */

/** Minimal valid magic-byte payloads, padded so detectDocumentType accepts them. */
const PDF_BYTES = Uint8Array.from([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0x00, 0x00,
]);
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function fileForm(file: File, description?: string): FormData {
  const fd = new FormData();
  fd.set("file", file);
  if (description !== undefined) fd.set("description", description);
  return fd;
}

describe("uploadAssetDocumentAction (P10-09)", () => {
  it("stores a PDF with the DETECTED mime, not the client header", async () => {
    const accountId = await seedAsset();
    // Lie about the type in the client header — the server must ignore it.
    const file = new File([PDF_BYTES], "title.pdf", { type: "text/html" });

    const res = await uploadAssetDocumentAction(accountId, {}, fileForm(file, "Vehicle title"));
    expect(res.ok).toBe(true);

    const docs = await db
      .select()
      .from(assetDocuments)
      .where(eq(assetDocuments.accountId, accountId));
    expect(docs).toHaveLength(1);
    expect(docs[0]?.mimeType).toBe("application/pdf"); // detected, not "text/html"
    expect(docs[0]?.filename).toBe("title.pdf");
    expect(docs[0]?.description).toBe("Vehicle title");
    expect(docs[0]?.sizeBytes).toBe(PDF_BYTES.byteLength);
    expect(docs[0]?.bytes.equals(Buffer.from(PDF_BYTES))).toBe(true);
  });

  it("rejects a disallowed type without writing a row", async () => {
    const accountId = await seedAsset();
    const svg = new File(
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
      "evil.svg",
      { type: "image/png" }, // spoofed header
    );
    const res = await uploadAssetDocumentAction(accountId, {}, fileForm(svg));
    expect(res.error).toBeTruthy();
    expect(await db.select().from(assetDocuments)).toHaveLength(0);
  });

  it("rejects upload to a non-asset account", async () => {
    const accountId = await seedAccount(); // depository
    const file = new File([PNG_BYTES], "x.png", { type: "image/png" });
    const res = await uploadAssetDocumentAction(accountId, {}, fileForm(file));
    expect(res.error).toBeTruthy();
    expect(await db.select().from(assetDocuments)).toHaveLength(0);
  });
});

describe("deleteAssetDocumentAction (P10-09)", () => {
  it("deletes only a document scoped to the given account", async () => {
    const accountId = await seedAsset();
    const file = new File([PNG_BYTES], "photo.png", { type: "image/png" });
    await uploadAssetDocumentAction(accountId, {}, fileForm(file));
    const [doc] = await db
      .select()
      .from(assetDocuments)
      .where(eq(assetDocuments.accountId, accountId));
    if (!doc) throw new Error("expected a document");

    const res = await deleteAssetDocumentAction(accountId, doc.id);
    expect(res.ok).toBe(true);
    expect(await db.select().from(assetDocuments)).toHaveLength(0);
  });

  it("is a no-op for a docId belonging to another account", async () => {
    const accountId = await seedAsset();
    const file = new File([PNG_BYTES], "photo.png", { type: "image/png" });
    await uploadAssetDocumentAction(accountId, {}, fileForm(file));
    const [doc] = await db
      .select()
      .from(assetDocuments)
      .where(eq(assetDocuments.accountId, accountId));
    if (!doc) throw new Error("expected a document");

    // A different (valid-format) account id that does not own the doc.
    const res = await deleteAssetDocumentAction(crypto.randomUUID(), doc.id).catch(() => undefined);
    // Either rejected (account not found) or a scoped no-op — never deletes it.
    void res;
    expect(await db.select().from(assetDocuments)).toHaveLength(1);
  });

  it("rejects a malformed document id", async () => {
    const accountId = await seedAsset();
    const res = await deleteAssetDocumentAction(accountId, "not-a-uuid");
    expect(res.error).toBeTruthy();
  });
});

/* ---------------------------------------------------------------------------
 * P15-29 / P15-30 — the terms that make the guidance engine's columns real.
 * --------------------------------------------------------------------------- */

async function seedTypedAccount(type: NewAccount["type"]): Promise<string> {
  await db.execute(sql`TRUNCATE accounts, credit_lines CASCADE`);
  const [account] = await db
    .insert(accounts)
    .values({ name: "Test", institution: "Bank", type, currency: "USD" })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account");
  return account.id;
}

async function readTypedAccount(id: string) {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
  return row;
}

describe("updateAccountTermsAction (P15-29)", () => {
  it("records a subtype and an APY", async () => {
    const id = await seedTypedAccount("depository");

    const res = await updateAccountTermsAction(
      id,
      {},
      lotForm({ subtype: "savings", apy: "4.5", maturityDate: "", taxTreatment: "" }),
    );

    expect(res.ok).toBe(true);
    const row = await readTypedAccount(id);
    expect(row?.subtype).toBe("savings");
    // Stored as a percentage at the column's scale (CLAUDE.md §Money: units are
    // part of the value, and APY is a percent while APR is a fraction).
    expect(row?.apy).toBe("4.5000");
  });

  it("clears a subtype back to null rather than defaulting it", async () => {
    // An unset subtype must stay distinguishable from a deliberately-chosen one,
    // so the engine can report `unclassified` instead of assuming checking.
    const id = await seedTypedAccount("depository");
    await updateAccountTermsAction(id, {}, lotForm({ subtype: "savings" }));

    await updateAccountTermsAction(id, {}, lotForm({ subtype: "" }));

    expect((await readTypedAccount(id))?.subtype).toBeNull();
  });

  it("stores a maturity date on a CD", async () => {
    const id = await seedTypedAccount("depository");

    await updateAccountTermsAction(
      id,
      {},
      lotForm({ subtype: "cd", apy: "5", maturityDate: "2027-06-30" }),
    );

    expect((await readTypedAccount(id))?.maturityDate).toBe("2027-06-30");
  });

  it("refuses a maturity date on a non-CD without writing anything", async () => {
    const id = await seedTypedAccount("depository");

    const res = await updateAccountTermsAction(
      id,
      {},
      lotForm({ subtype: "checking", maturityDate: "2027-06-30" }),
    );

    expect(res.error).toContain("CD");
    expect((await readTypedAccount(id))?.subtype).toBeNull();
  });

  it("drops a stale maturity date when a CD is reclassified", async () => {
    const id = await seedTypedAccount("depository");
    await updateAccountTermsAction(id, {}, lotForm({ subtype: "cd", maturityDate: "2027-06-30" }));

    await updateAccountTermsAction(id, {}, lotForm({ subtype: "savings" }));

    const row = await readTypedAccount(id);
    expect(row?.subtype).toBe("savings");
    expect(row?.maturityDate).toBeNull();
  });

  it("rejects an APY entered as a fraction of 100 or more", async () => {
    const id = await seedTypedAccount("depository");

    const res = await updateAccountTermsAction(id, {}, lotForm({ apy: "450" }));

    expect(res.error).toContain("percentage");
    expect((await readTypedAccount(id))?.apy).toBeNull();
  });

  it("records a tax treatment on an investment account", async () => {
    const id = await seedTypedAccount("investment");

    await updateAccountTermsAction(id, {}, lotForm({ taxTreatment: "roth" }));

    expect((await readTypedAccount(id))?.taxTreatment).toBe("roth");
  });
});

describe("saveCreditLineTermsAction (P15-30)", () => {
  async function readLine(accountId: string) {
    const [row] = await db.select().from(creditLines).where(eq(creditLines.accountId, accountId));
    return row;
  }

  it("creates terms on first save", async () => {
    const id = await seedTypedAccount("credit_card");

    const res = await saveCreditLineTermsAction(
      id,
      {},
      lotForm({ apr: "0.2499", creditLimit: "5000.00", minimumPayment: "35.00" }),
    );

    expect(res.ok).toBe(true);
    const row = await readLine(id);
    expect(row?.apr).toBe("0.249900");
    expect(row?.creditLimit).toBe("5000.00");
  });

  it("updates in place — a card has exactly one set of terms", async () => {
    const id = await seedTypedAccount("credit_card");
    await saveCreditLineTermsAction(id, {}, lotForm({ apr: "0.2499" }));

    await saveCreditLineTermsAction(id, {}, lotForm({ apr: "0.1899" }));

    expect(await db.select().from(creditLines)).toHaveLength(1);
    expect((await readLine(id))?.apr).toBe("0.189900");
  });

  it("accepts a limit with no APR", async () => {
    // The engine reports the missing APR as unknown_input; refusing the entry
    // would cost the user working utilization figures for nothing.
    const id = await seedTypedAccount("credit_card");

    await saveCreditLineTermsAction(id, {}, lotForm({ creditLimit: "5000.00" }));

    const row = await readLine(id);
    expect(row?.creditLimit).toBe("5000.00");
    expect(row?.apr).toBeNull();
  });

  it("rejects an APR typed as a percentage", async () => {
    // 24.99 as a fraction is a 2499% card — the single most consequential
    // data-entry error in this phase.
    const id = await seedTypedAccount("credit_card");

    const res = await saveCreditLineTermsAction(id, {}, lotForm({ apr: "24.99" }));

    expect(res.error).toContain("0.2499");
    expect(await db.select().from(creditLines)).toHaveLength(0);
  });

  it("refuses to attach revolving terms to anything but a card", async () => {
    const id = await seedTypedAccount("loan");

    const res = await saveCreditLineTermsAction(id, {}, lotForm({ apr: "0.065" }));

    expect(res.error).toBeTruthy();
    expect(await db.select().from(creditLines)).toHaveLength(0);
  });

  it("re-stamps updated_at on every save so the staleness note stays honest", async () => {
    const id = await seedTypedAccount("credit_card");
    await saveCreditLineTermsAction(id, {}, lotForm({ apr: "0.2499" }));
    const first = (await readLine(id))?.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveCreditLineTermsAction(id, {}, lotForm({ apr: "0.2499" }));

    // The user is asserting "this is still right today", which is exactly what
    // the displayed date has to mean for it to be worth showing.
    const second = (await readLine(id))?.updatedAt;
    expect(second?.getTime()).toBeGreaterThan(first?.getTime() ?? 0);
  });
});
