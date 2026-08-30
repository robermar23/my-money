import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @vitest-environment node
import { db } from "@/db/client.ts";
import { accountSnapshots, accounts } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type NormalizedBatch, qfxToNormalized } from "./normalize.ts";
import { parseQfx } from "./qfx/parse.ts";
import { reconcile } from "./reconcile.ts";

function fixture(rel: string): Buffer {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
}

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE transactions, import_batches, account_snapshots, accounts CASCADE`);
}

async function seedAccount(type: "depository" | "credit_card" = "depository"): Promise<string> {
  const [acc] = await db
    .insert(accounts)
    .values({ name: "M&T", institution: "M&T", type, currency: "USD" })
    .returning({ id: accounts.id });
  if (!acc) throw new Error("seed");
  return acc.id;
}

/**
 * A batch shell for the advisory cases, where the transactions do not matter —
 * only the account type and the sign of the ending balance do.
 */
function batchOf(accountId: string, endingBalance: string | null) {
  return {
    accountId,
    statementStart: "2026-02-01",
    statementEnd: "2026-02-28",
    statementEndingBalance: endingBalance,
  };
}

const EMPTY_BATCH: NormalizedBatch = {
  source: "qfx",
  statementStart: "2026-02-01",
  statementEnd: "2026-02-28",
  statementEndingBalance: null,
  currency: "USD",
  transactions: [],
  metadata: {},
};

describe("reconcile", () => {
  beforeEach(async () => {
    await reset();
  });
  afterAll(async () => {
    await reset();
  });

  it("returns 'no-anchor' when no prior snapshot exists for the account", async () => {
    const accountId = await seedAccount();
    const normalized = qfxToNormalized(parseQfx(fixture("./qfx/__fixtures__/mt-checking.qfx")));
    const result = await reconcile(
      {
        accountId,
        statementStart: normalized.statementStart,
        statementEnd: normalized.statementEnd,
        statementEndingBalance: normalized.statementEndingBalance,
      },
      normalized,
      "USD",
      "depository",
    );
    expect(result.status).toBe("no-anchor");
    expect(result.endingBalance?.toString()).toBe("1639.40");
    expect(result.cardSignSuspect).toBe(false);
  });

  it("returns 'ok' when the prior snapshot + new transactions match the file's ending balance", async () => {
    const accountId = await seedAccount();
    const normalized = qfxToNormalized(parseQfx(fixture("./qfx/__fixtures__/mt-checking.qfx")));

    // Anchor: prior snapshot the day before statement_start. The QFX sums to
    //   2500 - 87.42 - 450 - 23.18 - 300 = 1639.40
    // and the ledger ending balance is 1639.40, so any prior snapshot = 0 works.
    await db.insert(accountSnapshots).values({
      accountId,
      date: "2026-01-31",
      balance: "0.00",
    });

    const result = await reconcile(
      {
        accountId,
        statementStart: normalized.statementStart,
        statementEnd: normalized.statementEnd,
        statementEndingBalance: normalized.statementEndingBalance,
      },
      normalized,
      "USD",
      "depository",
    );
    expect(result.status).toBe("ok");
    expect(result.diff?.toString()).toBe("0.00");
  });

  it("returns 'mismatch' with the right delta when a transaction is missing", async () => {
    const accountId = await seedAccount();
    const normalized = qfxToNormalized(parseQfx(fixture("./qfx/__fixtures__/mt-checking.qfx")));

    // Anchor at 100 instead of 0 — expected ending = 100 + sum(1639.40) = 1739.40
    // but file says 1639.40 → drift = -100.00
    await db.insert(accountSnapshots).values({
      accountId,
      date: "2026-01-31",
      balance: "100.00",
    });

    const result = await reconcile(
      {
        accountId,
        statementStart: normalized.statementStart,
        statementEnd: normalized.statementEnd,
        statementEndingBalance: normalized.statementEndingBalance,
      },
      normalized,
      "USD",
      "depository",
    );
    expect(result.status).toBe("mismatch");
    expect(result.diff?.toString()).toBe("-100.00");
  });
});

/**
 * P17-33 — the credit-card sign advisory (ADR-042 §5).
 *
 * The rule itself is one comparison. What these cases pin is the *design*: the
 * advisory is orthogonal to `status`, so it must survive every status rather
 * than being one more member of the union — a card can have no anchor and a
 * suspicious sign at the same time, and a UI forced to pick one would show the
 * less important one. They also pin that nothing is flipped: `endingBalance`
 * comes back exactly as the file wrote it, because the OFX LEDGERBAL sign for a
 * card is institution-dependent and guessing is confidently wrong for some
 * banks.
 */
describe("credit-card sign advisory", () => {
  beforeEach(async () => {
    await reset();
  });
  afterAll(async () => {
    await reset();
  });

  it("flags a card whose statement ending balance is positive", async () => {
    const accountId = await seedAccount("credit_card");

    const result = await reconcile(
      batchOf(accountId, "1200.00"),
      EMPTY_BATCH,
      "USD",
      "credit_card",
    );

    expect(result.cardSignSuspect).toBe(true);
    // And it is an advisory, not a rewrite: the value is untouched.
    expect(result.endingBalance?.toString()).toBe("1200.00");
  });

  it("does not flag a card whose ending balance is already negative", async () => {
    const accountId = await seedAccount("credit_card");

    const result = await reconcile(
      batchOf(accountId, "-1200.00"),
      EMPTY_BATCH,
      "USD",
      "credit_card",
    );

    expect(result.cardSignSuspect).toBe(false);
  });

  it("does not flag a zero-balance card — a paid-off card is not suspicious", async () => {
    const accountId = await seedAccount("credit_card");

    const result = await reconcile(batchOf(accountId, "0.00"), EMPTY_BATCH, "USD", "credit_card");

    expect(result.cardSignSuspect).toBe(false);
  });

  it("does not flag a depository with a positive ending balance — the normal case", async () => {
    const accountId = await seedAccount("depository");

    const result = await reconcile(batchOf(accountId, "1200.00"), EMPTY_BATCH, "USD", "depository");

    expect(result.cardSignSuspect).toBe(false);
  });

  it("composes with 'no-anchor' — both are true at once", async () => {
    // No prior snapshot was seeded, so the status is `no-anchor`. The advisory
    // must ride alongside it rather than being displaced by it.
    const accountId = await seedAccount("credit_card");

    const result = await reconcile(
      batchOf(accountId, "1200.00"),
      EMPTY_BATCH,
      "USD",
      "credit_card",
    );

    expect(result.status).toBe("no-anchor");
    expect(result.cardSignSuspect).toBe(true);
  });

  it("composes with 'mismatch' — a sign-suspect card can also fail to reconcile", async () => {
    const accountId = await seedAccount("credit_card");
    await db.insert(accountSnapshots).values({
      accountId,
      date: "2026-01-31",
      balance: "-500.00",
    });

    const result = await reconcile(
      batchOf(accountId, "1200.00"),
      EMPTY_BATCH,
      "USD",
      "credit_card",
    );

    expect(result.status).toBe("mismatch");
    expect(result.cardSignSuspect).toBe(true);
  });

  it("is false for 'no-balance' — there is no sign to be suspicious of", async () => {
    const accountId = await seedAccount("credit_card");

    const result = await reconcile(batchOf(accountId, null), EMPTY_BATCH, "USD", "credit_card");

    expect(result.status).toBe("no-balance");
    expect(result.cardSignSuspect).toBe(false);
  });
});
