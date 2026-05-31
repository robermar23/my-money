import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @vitest-environment node
import { db } from "@/db/client.ts";
import { accountSnapshots, accounts } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { qfxToNormalized } from "./normalize.ts";
import { parseQfx } from "./qfx/parse.ts";
import { reconcile } from "./reconcile.ts";

function fixture(rel: string): Buffer {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
}

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE transactions, import_batches, account_snapshots, accounts CASCADE`);
}

async function seedAccount(): Promise<string> {
  const [acc] = await db
    .insert(accounts)
    .values({ name: "M&T", institution: "M&T", type: "depository", currency: "USD" })
    .returning({ id: accounts.id });
  if (!acc) throw new Error("seed");
  return acc.id;
}

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
    );
    expect(result.status).toBe("no-anchor");
    expect(result.endingBalance?.toString()).toBe("1639.40");
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
    );
    expect(result.status).toBe("mismatch");
    expect(result.diff?.toString()).toBe("-100.00");
  });
});
