import { db } from "@/db/client.ts";
import { accountSnapshots, accounts } from "@/db/schema/index.ts";
import { recordBalanceSchema } from "@/lib/schemas/account.ts";
import { sql } from "drizzle-orm";
// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { computeNetWorth } from "./compute.ts";

/**
 * P17-08 — the credit-card sign verification ADR-041 §7 requires *before* any
 * rung is allowed to depend on the convention.
 *
 * The claim under test: `account_snapshots.balance` for a `credit_card` account
 * is stored **negative**, because [compute.ts](./compute.ts) sums snapshot
 * balances verbatim and negates only `loan` accounts. If a card were stored
 * positive, the shipped net-worth total would be wrong by twice the balance —
 * and every figure anchored to it would inherit that error silently.
 *
 * The first two cases are integration tests on purpose: the convention is a
 * property of what the app *writes*, and only the database can answer that. The
 * third is the finding — the convention is enforced on one write path and not
 * the other. See [asset-revaluation.ts](./asset-revaluation.ts) for what that
 * means for this phase.
 */

async function resetDomain(): Promise<void> {
  await db.execute(sql`TRUNCATE accounts, holdings, account_snapshots, liabilities CASCADE`);
}

async function card(name = "Visa"): Promise<string> {
  const [row] = await db
    .insert(accounts)
    .values({ name, institution: "M&T", type: "credit_card", currency: "USD" })
    .returning({ id: accounts.id });
  if (!row) throw new Error("seed failed");
  return row.id;
}

describe("credit_card snapshot sign", () => {
  beforeEach(async () => {
    await resetDomain();
  });

  afterAll(async () => {
    await resetDomain();
  });

  it("reduces net worth when stored negative — the convention the shipped math needs", async () => {
    const id = await card();
    await db
      .insert(accountSnapshots)
      .values({ accountId: id, date: "2026-05-01", balance: "-1200.00" });

    const nw = await computeNetWorth();

    expect(nw.total.toString()).toBe("-1200.00");
  });

  it("sums a card balance VERBATIM, applying no sign normalization of its own", async () => {
    // The finding, pinned. `computeNetWorth` negates `loan` accounts and nothing
    // else, so a positively-stored card is counted as an ASSET and the total is
    // wrong by twice the balance. The convention lives entirely with the writer,
    // and this assertion is what tells a future phase that adding normalization
    // here would be a deliberate behaviour change, not a quiet bug fix.
    const id = await card();
    await db
      .insert(accountSnapshots)
      .values({ accountId: id, date: "2026-05-01", balance: "1200.00" });

    const nw = await computeNetWorth();

    expect(nw.total.toString()).toBe("1200.00");
  });

  it("accepts an unsigned balance from the manual entry path, so the convention is unenforced there", () => {
    // The Plaid path enforces it — `sync-plaid-item.ts` negates explicitly for
    // `credit_card`. The manual path does not: `recordBalanceAction` stores
    // whatever `recordBalanceSchema` accepts, and that regex makes the sign
    // optional. A household typing "1200.00" for a card they owe $1,200 on
    // overstates net worth by $2,400 with no warning anywhere.
    //
    // This is recorded rather than fixed here: changing the manual path is a
    // write-side behaviour change that belongs to whichever phase owns balance
    // entry, not to a read-time attribution feature (ADR-039 §3).
    expect(recordBalanceSchema.safeParse({ date: "2026-05-01", balance: "1200.00" }).success).toBe(
      true,
    );
    expect(recordBalanceSchema.safeParse({ date: "2026-05-01", balance: "-1200.00" }).success).toBe(
      true,
    );
  });
});
