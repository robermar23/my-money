// @vitest-environment node
import { db } from "@/db/client.ts";
import { accountSnapshots, accounts } from "@/db/schema/index.ts";
import { recordBalanceSchema } from "@/lib/schemas/account.ts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computeNetWorth } from "./compute.ts";

/**
 * P17-08 — the credit-card sign verification ADR-041 §7 required *before* any
 * rung was allowed to depend on the convention.
 * P17-32/34 — the same file, after ADR-042 closed what it found.
 *
 * The claim under test: `account_snapshots.balance` for a `credit_card` account
 * is stored **negative**, because [compute.ts](./compute.ts) sums snapshot
 * balances verbatim and negates only `loan` accounts. If a card were stored
 * positive, the shipped net-worth total would be wrong by twice the balance —
 * and every figure anchored to it would inherit that error silently.
 *
 * These are integration tests on purpose: the convention is a property of what
 * the app *writes*, and only the database can answer that.
 *
 * **What changed in P17-32.** The original third case pinned a defect rather
 * than a guarantee — the manual entry path stored whatever the user typed, so a
 * household reading `$1,234.56` off a Visa statement overstated its net worth by
 * twice that. ADR-042 moved the rule into [sign.ts](../snapshots/sign.ts) and
 * put every write path on it, so that case is now the opposite assertion: the
 * form asks for an **amount owed** and the action negates it.
 *
 * **What deliberately did NOT change**: the read side. `computeNetWorth` still
 * sums a card verbatim. The fix belongs at the write boundary, and normalizing
 * on read would double-negate every row the Plaid path has always stored
 * correctly. That assertion stays, reworded from "the finding" to "the
 * contract", because a future phase must be able to see that adding
 * normalization there would be a behaviour change rather than a bug fix.
 */

vi.mock("@/lib/auth/require-user.ts", () => ({
  requireUser: vi.fn(async () => ({
    id: "00000000-0000-0000-0000-000000000001",
    passwordHash: "fake",
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { recordBalanceAction } = await import("@/app/accounts/[id]/actions.ts");

async function resetDomain(): Promise<void> {
  await db.execute(sql`TRUNCATE accounts, holdings, account_snapshots, liabilities CASCADE`);
}

async function account(type: "credit_card" | "depository", name = "Visa"): Promise<string> {
  const [row] = await db
    .insert(accounts)
    .values({ name, institution: "M&T", type, currency: "USD" })
    .returning({ id: accounts.id });
  if (!row) throw new Error("seed failed");
  return row.id;
}

/** Enter a balance through the real server action, as the form does. */
async function enterBalance(accountId: string, balance: string): Promise<void> {
  const form = new FormData();
  form.set("date", "2026-05-01");
  form.set("balance", balance);
  const result = await recordBalanceAction(accountId, {}, form);
  expect(result.error).toBeUndefined();
}

async function storedBalance(accountId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ balance: accountSnapshots.balance })
    .from(accountSnapshots)
    .where(eq(accountSnapshots.accountId, accountId));
  return row?.balance;
}

describe("credit_card snapshot sign", () => {
  beforeEach(async () => {
    await resetDomain();
  });

  afterAll(async () => {
    await resetDomain();
  });

  it("reduces net worth when stored negative — the convention the shipped math needs", async () => {
    const id = await account("credit_card");
    await db
      .insert(accountSnapshots)
      .values({ accountId: id, date: "2026-05-01", balance: "-1200.00" });

    const nw = await computeNetWorth();

    expect(nw.total.toString()).toBe("-1200.00");
  });

  it("sums a card balance VERBATIM, applying no sign normalization of its own", async () => {
    // The read-side contract, pinned. `computeNetWorth` negates `loan` accounts
    // and nothing else, so a positively-stored card would be counted as an
    // ASSET. That is not a gap to be closed here: ADR-042 puts the rule at the
    // write boundary precisely so this stays a plain sum, and adding
    // normalization here would double-negate every row the Plaid path has been
    // storing correctly since Phase 4. This assertion is what tells a future
    // phase that touching it is a deliberate behaviour change.
    const id = await account("credit_card");
    await db
      .insert(accountSnapshots)
      .values({ accountId: id, date: "2026-05-01", balance: "1200.00" });

    const nw = await computeNetWorth();

    expect(nw.total.toString()).toBe("1200.00");
  });
});

describe("manual entry enforces the convention (P17-32, ADR-042)", () => {
  beforeEach(async () => {
    await resetDomain();
  });

  afterAll(async () => {
    await resetDomain();
  });

  it("stores a card's amount owed negated, so net worth falls", async () => {
    // The case the original suite recorded as broken. A household types what its
    // statement says — $1,200 owed — and the app stores the net-worth
    // contribution. Before ADR-042 this stored `1200.00` and reported a net
    // worth of `+1200.00`: wrong by $2,400, with no warning anywhere.
    const id = await account("credit_card");

    await enterBalance(id, "1200.00");

    expect(await storedBalance(id)).toBe("-1200.00");
    expect((await computeNetWorth()).total.toString()).toBe("-1200.00");
  });

  it("leaves a depository balance alone — only liabilities are negated", async () => {
    const id = await account("depository", "Everyday Checking");

    await enterBalance(id, "1200.00");

    expect(await storedBalance(id)).toBe("1200.00");
    expect((await computeNetWorth()).total.toString()).toBe("1200.00");
  });

  it("stores an overpaid card positive, because the mapping is a plain negation", async () => {
    // Rare but real, and every rejected alternative in ADR-042 made it
    // inexpressible — a validation error on positive amounts, or a CHECK
    // constraint forcing card balances non-positive.
    const id = await account("credit_card");

    await enterBalance(id, "-75.00");

    expect(await storedBalance(id)).toBe("75.00");
    expect((await computeNetWorth()).total.toString()).toBe("75.00");
  });

  it("re-entering the same date overwrites rather than accumulating", async () => {
    // The UPSERT is what makes a corrected entry a correction. Worth asserting
    // alongside the negation because a household that mis-typed a card balance
    // fixes it by typing it again.
    const id = await account("credit_card");

    await enterBalance(id, "1200.00");
    await enterBalance(id, "950.00");

    expect(await storedBalance(id)).toBe("-950.00");
  });

  it("still accepts an unsigned amount at the schema — that is now the POINT", async () => {
    // This assertion used to read "so the convention is unenforced there". The
    // schema is unchanged and still permissive, but its meaning inverted: the
    // field asks for an amount owed, so an unsigned entry is the *expected*
    // input for a card and the leading minus is how an overpaid card is
    // expressed. Enforcement moved from the schema, where it could only have
    // been a hostile validation error, to `snapshotBalance`.
    expect(recordBalanceSchema.safeParse({ date: "2026-05-01", balance: "1200.00" }).success).toBe(
      true,
    );
    expect(recordBalanceSchema.safeParse({ date: "2026-05-01", balance: "-1200.00" }).success).toBe(
      true,
    );
  });
});
