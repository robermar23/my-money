import { db } from "@/db/client.ts";
import { accountSnapshots, accounts, holdings, liabilities } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { computeNetWorth, netWorthSeries } from "./compute.ts";

/**
 * Integration tests for computeNetWorth — exercise against the dev Postgres
 * container. Each test wipes the domain tables first so order doesn't matter.
 *
 * If DATABASE_URL is unreachable, vitest will error on the import of db/client.
 */

async function resetDomain(): Promise<void> {
  await db.execute(sql`TRUNCATE accounts, holdings, account_snapshots, liabilities CASCADE`);
}

describe("computeNetWorth", () => {
  beforeEach(async () => {
    await resetDomain();
  });

  afterAll(async () => {
    await resetDomain();
  });

  it("returns $0 when no accounts exist", async () => {
    const nw = await computeNetWorth();
    expect(nw.total.toString()).toBe("0.00");
    expect(nw.items).toHaveLength(0);
  });

  it("sums one positive cash account", async () => {
    const [acc] = await db
      .insert(accounts)
      .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
      .returning({ id: accounts.id });
    if (!acc) throw new Error("seed failed");
    await db
      .insert(accountSnapshots)
      .values({ accountId: acc.id, date: "2026-05-01", balance: "5000.00" });

    const nw = await computeNetWorth();
    expect(nw.total.toString()).toBe("5000.00");
  });

  it("subtracts loan balance from net worth via amortization", async () => {
    const [cash] = await db
      .insert(accounts)
      .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
      .returning({ id: accounts.id });
    const [loanAcc] = await db
      .insert(accounts)
      .values({ name: "Mortgage", institution: "Sunwest", type: "loan", currency: "USD" })
      .returning({ id: accounts.id });
    if (!cash || !loanAcc) throw new Error("seed failed");

    await db
      .insert(accountSnapshots)
      .values({ accountId: cash.id, date: "2026-05-01", balance: "100000.00" });

    // 6% / 30yr loan, just originated today → ~full principal still owed
    const today = new Date().toISOString().slice(0, 10);
    await db.insert(liabilities).values({
      accountId: loanAcc.id,
      name: "Sunwest 30yr",
      principalAtOrigination: "200000.00",
      annualRate: "0.06",
      termMonths: 360,
      startDate: today,
    });

    const nw = await computeNetWorth();
    // Cash 100k - loan ~200k → net worth is negative ~100k.
    // Allow $1 tolerance since principal-at-month-0 = full principal exactly.
    expect(Number(nw.total.toString())).toBeCloseTo(-100000, 0);
  });

  it("uses the most-recent snapshot on or before asOf", async () => {
    const [acc] = await db
      .insert(accounts)
      .values({ name: "Savings", institution: "M&T", type: "depository", currency: "USD" })
      .returning({ id: accounts.id });
    if (!acc) throw new Error("seed failed");
    await db.insert(accountSnapshots).values([
      { accountId: acc.id, date: "2026-01-01", balance: "1000.00" },
      { accountId: acc.id, date: "2026-03-01", balance: "1500.00" },
      { accountId: acc.id, date: "2026-05-01", balance: "2000.00" },
    ]);

    const nwAtMarch = await computeNetWorth(new Date("2026-03-15T00:00:00Z"));
    expect(nwAtMarch.total.toString()).toBe("1500.00");

    const nwAtMay = await computeNetWorth(new Date("2026-05-15T00:00:00Z"));
    expect(nwAtMay.total.toString()).toBe("2000.00");
  });

  it("netWorthSeries emits one point per distinct snapshot date", async () => {
    const [acc] = await db
      .insert(accounts)
      .values({ name: "Checking", institution: "M&T", type: "depository", currency: "USD" })
      .returning({ id: accounts.id });
    if (!acc) throw new Error("seed failed");
    await db.insert(accountSnapshots).values([
      { accountId: acc.id, date: "2026-01-01", balance: "100.00" },
      { accountId: acc.id, date: "2026-02-01", balance: "200.00" },
      { accountId: acc.id, date: "2026-03-01", balance: "300.00" },
    ]);

    const series = await netWorthSeries();
    expect(series.map((p) => p.value)).toEqual(["100.00", "200.00", "300.00"]);
  });
});

// Keep the `holdings` import referenced so the schema barrel doesn't tree-shake.
void holdings;
