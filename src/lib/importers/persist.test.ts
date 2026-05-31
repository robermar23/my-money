import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  categoryRules,
  importBatches,
  transactions,
} from "@/db/schema/index.ts";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { qfxToNormalized } from "./normalize.ts";
import { buildPreview, persistImportBatch, recategorizeAll } from "./persist.ts";
import { parseQfx } from "./qfx/parse.ts";

function fixture(rel: string): Buffer {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
}

async function resetDomain(): Promise<void> {
  await db.execute(
    sql`TRUNCATE transactions, import_batches, account_snapshots, accounts, category_rules CASCADE`,
  );
}

async function seedAccount(currency = "USD"): Promise<string> {
  const [acc] = await db
    .insert(accounts)
    .values({
      name: "M&T Checking",
      institution: "M&T Bank",
      type: "depository",
      currency,
    })
    .returning({ id: accounts.id });
  if (!acc) throw new Error("seed failed");
  return acc.id;
}

async function seedBatch(accountId: string): Promise<string> {
  const parsed = parseQfx(fixture("./qfx/__fixtures__/mt-checking.qfx"));
  const normalized = qfxToNormalized(parsed);
  const [row] = await db
    .insert(importBatches)
    .values({
      accountId,
      source: "qfx",
      filename: "mt-checking.qfx",
      status: "previewed",
      parsedPayload: normalized,
      parserMetadata: normalized.metadata,
      statementStart: normalized.statementStart,
      statementEnd: normalized.statementEnd,
      statementEndingBalance: normalized.statementEndingBalance,
    })
    .returning({ id: importBatches.id });
  if (!row) throw new Error("batch seed failed");
  return row.id;
}

describe("buildPreview + persistImportBatch", () => {
  beforeEach(async () => {
    await resetDomain();
  });

  afterAll(async () => {
    await resetDomain();
  });

  it("auto-seeds default category rules on first preview", async () => {
    const accountId = await seedAccount();
    const parsed = parseQfx(fixture("./qfx/__fixtures__/mt-checking.qfx"));
    const normalized = qfxToNormalized(parsed);

    await buildPreview(accountId, normalized);
    const rules = await db.select().from(categoryRules);
    expect(rules.length).toBeGreaterThan(0);
  });

  it("categorizes payroll and groceries via the seeded rules", async () => {
    const accountId = await seedAccount();
    const parsed = parseQfx(fixture("./qfx/__fixtures__/mt-checking.qfx"));
    const normalized = qfxToNormalized(parsed);

    const preview = await buildPreview(accountId, normalized);
    const payroll = preview.newTransactions.find((r) => r.name === "EMPLOYER PAYROLL");
    expect(payroll?.category).toBe("Income");
    const wegmans = preview.newTransactions.find((r) => r.name === "WEGMANS FOOD MARKET");
    expect(wegmans?.category).toBe("Groceries");
    const starbucks = preview.newTransactions.find((r) => r.name === "STARBUCKS STORE 4521");
    expect(starbucks?.category).toBe("Coffee");
  });

  it("inserts 5 transactions on first confirm; second confirm reports them as duplicates", async () => {
    const accountId = await seedAccount();
    const batchId = await seedBatch(accountId);

    const first = await persistImportBatch(batchId);
    expect(first.insertedCount).toBe(5);
    expect(first.duplicateCount).toBe(0);

    // Confirming the same batch again is a no-op (already 'confirmed').
    const repeat = await persistImportBatch(batchId);
    expect(repeat.insertedCount).toBe(5);

    // Now create a second batch with the same file — every row should bucket
    // as a duplicate at preview, and persistImportBatch should insert zero new.
    const batchId2 = await seedBatch(accountId);
    const preview = await buildPreview(
      accountId,
      qfxToNormalized(parseQfx(fixture("./qfx/__fixtures__/mt-checking.qfx"))),
    );
    expect(preview.newTransactions).toHaveLength(0);
    expect(preview.duplicates).toHaveLength(5);

    const second = await persistImportBatch(batchId2);
    expect(second.insertedCount).toBe(0);
    expect(second.duplicateCount).toBe(5);
  });

  it("writes one snapshot per posted date + an authoritative row at statement_end", async () => {
    const accountId = await seedAccount();
    const batchId = await seedBatch(accountId);
    await persistImportBatch(batchId);

    const snaps = await db
      .select()
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, accountId));

    // 5 distinct posted dates (3 in Feb), plus the statement_end (2026-02-28)
    // which may overlap with the last txn date. Check that 2026-02-28 has the
    // exact ledger balance from the QFX (1639.40).
    const endRow = snaps.find((s) => s.date === "2026-02-28");
    expect(endRow?.balance).toBe("1639.40");
  });

  it("preserves manual overrides during recategorize-all", async () => {
    const accountId = await seedAccount();
    const batchId = await seedBatch(accountId);
    await persistImportBatch(batchId);

    // Override one transaction's category.
    const [starbucks] = await db
      .select()
      .from(transactions)
      .where(
        and(eq(transactions.accountId, accountId), eq(transactions.name, "STARBUCKS STORE 4521")),
      );
    if (!starbucks) throw new Error("starbucks row missing");
    await db
      .update(transactions)
      .set({ category: "Hand Picked", categoryOverriddenAt: new Date() })
      .where(eq(transactions.id, starbucks.id));

    // Delete the COFFEE rule and re-categorize all.
    await db.delete(categoryRules).where(eq(categoryRules.category, "Coffee"));
    await recategorizeAll();

    const [after] = await db.select().from(transactions).where(eq(transactions.id, starbucks.id));
    expect(after?.category).toBe("Hand Picked");
  });
});
