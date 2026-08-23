// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accounts,
  holdingLots,
  holdings,
  incomeContributions,
  incomeSources,
  investmentTransactions,
  prices,
  retirementContributions,
} from "@/db/schema/index.ts";
import { resolveCostBasis } from "@/lib/investments/lots.ts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { materializeContributions } from "./materialize-contributions.ts";

/**
 * P14-09/P14-12 — the persistence half of contribution materialization.
 *
 * The math and the buy-vs-basis-only decision are already pinned by the pure
 * planner's tests (`src/lib/income/materialize.test.ts`). What can only be
 * tested against a real database is what this file covers: that the writes land
 * in the right tables with the right shape, that the UNIQUE key genuinely makes
 * a re-run a no-op, that contributed dollars resolve as the holding's cost
 * basis, and — the reconciliation guard — that the job never touches a
 * Plaid-synced or manual row.
 */

const PAY_DATE = "2026-01-02"; // the anchor, and a real biweekly pay date
const WINDOW = { from: "2026-01-01", to: "2026-01-02" } as const;

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE income_contributions, retirement_contributions, income_sources,
        investment_transactions, holding_lots, holdings, accounts, prices CASCADE`,
  );
}

async function seedAccount(): Promise<string> {
  const [a] = await db
    .insert(accounts)
    .values({ name: "401k", institution: "Fidelity", type: "investment", currency: "USD" })
    .returning({ id: accounts.id });
  if (!a) throw new Error("seed account failed");
  return a.id;
}

async function seedHolding(
  accountId: string,
  overrides: { quantity?: string; source?: string; symbol?: string } = {},
): Promise<string> {
  const [h] = await db
    .insert(holdings)
    .values({
      accountId,
      symbol: overrides.symbol ?? "FXAIX",
      quantity: overrides.quantity ?? "10",
      quantityUnit: "shares",
      assetClass: "equity",
      source: overrides.source ?? "manual",
    })
    .returning({ id: holdings.id });
  if (!h) throw new Error("seed holding failed");
  return h.id;
}

async function seedSource(
  overrides: Partial<typeof incomeSources.$inferInsert> = {},
): Promise<string> {
  const [s] = await db
    .insert(incomeSources)
    .values({
      name: "Acme Corp",
      cadence: "biweekly",
      grossPerPeriod: "3000.00",
      currency: "USD",
      anchorDate: PAY_DATE,
      startDate: "2026-01-01",
      ...overrides,
    })
    .returning({ id: incomeSources.id });
  if (!s) throw new Error("seed source failed");
  return s.id;
}

/** 6% employee + a 3%-of-gross match on $3,000 gross → 180 + 90 = 270. */
async function seedRule(
  incomeSourceId: string,
  accountId: string,
  holdingId: string | null,
  overrides: Partial<typeof retirementContributions.$inferInsert> = {},
): Promise<string> {
  const [r] = await db
    .insert(retirementContributions)
    .values({
      incomeSourceId,
      accountId,
      holdingId,
      employeeBasis: "percent",
      employeeValue: "6",
      matchBasis: "percent_of_gross",
      matchValue: "3",
      ...overrides,
    })
    .returning({ id: retirementContributions.id });
  if (!r) throw new Error("seed rule failed");
  return r.id;
}

async function seedPrice(close: string, date = PAY_DATE, symbol = "FXAIX"): Promise<void> {
  await db.insert(prices).values({ symbol, date, close });
}

/** The full priceable fixture: account + priced holding + source + rule. */
async function seedPriceableRule(holdingOverrides: { quantity?: string; source?: string } = {}) {
  const accountId = await seedAccount();
  const holdingId = await seedHolding(accountId, holdingOverrides);
  const sourceId = await seedSource();
  const ruleId = await seedRule(sourceId, accountId, holdingId);
  await seedPrice("100.00");
  return { accountId, holdingId, sourceId, ruleId };
}

const only = async <T>(rows: Promise<T[]>): Promise<T> => {
  const all = await rows;
  const [first] = all;
  if (first === undefined) throw new Error(`expected exactly one row, got ${all.length}`);
  return first;
};

describe("materializeContributions — priceable contribution", () => {
  beforeEach(reset);
  afterAll(reset);

  it("writes a buy, a cost-basis lot, and a ledger row for one pay date", async () => {
    const { accountId, holdingId, ruleId } = await seedPriceableRule();

    const result = await materializeContributions(WINDOW);
    expect(result).toEqual({ rules: 1, created: 1, priceable: 1, basisOnly: 0 });

    const txn = await only(
      db
        .select()
        .from(investmentTransactions)
        .where(eq(investmentTransactions.accountId, accountId)),
    );
    expect(txn.type).toBe("buy");
    expect(txn.subtype).toBe("contribution");
    expect(txn.source).toBe("income");
    expect(txn.tradeDate).toBe(PAY_DATE);
    expect(txn.quantity).toBe("2.70000000"); // 270 ÷ 100
    expect(txn.price).toBe("100.00000000");
    // Negative: cash leaving the sleeve to acquire shares (app-wide convention).
    expect(txn.amount).toBe("-270.00");

    const lot = await only(
      db.select().from(holdingLots).where(eq(holdingLots.holdingId, holdingId)),
    );
    expect(lot.source).toBe("income");
    expect(lot.quantity).toBe("2.70000000");
    expect(lot.costBasisTotal).toBe("270.00");
    expect(lot.acquiredAt).toBe(PAY_DATE);

    const ledger = await only(
      db
        .select()
        .from(incomeContributions)
        .where(eq(incomeContributions.retirementContributionId, ruleId)),
    );
    expect(ledger.payDate).toBe(PAY_DATE);
    expect(ledger.grossAmount).toBe("3000.00");
    expect(ledger.employeeAmount).toBe("180.00");
    expect(ledger.employerAmount).toBe("90.00");
    // Auditable back to what it created.
    expect(ledger.investmentTransactionId).toBe(txn.id);
    expect(ledger.holdingLotId).toBe(lot.id);
  });

  it("is a no-op on a second run (the UNIQUE key, not bookkeeping)", async () => {
    await seedPriceableRule();

    const first = await materializeContributions(WINDOW);
    const second = await materializeContributions(WINDOW);

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(await db.select().from(investmentTransactions)).toHaveLength(1);
    expect(await db.select().from(holdingLots)).toHaveLength(1);
    expect(await db.select().from(incomeContributions)).toHaveLength(1);
  });

  it("grows the position so value tracks basis", async () => {
    // Nothing else maintains quantity for a contribution-funded holding, and
    // valuation is quantity × close — without this the basis would climb while
    // the 401k's value stood still.
    const { holdingId } = await seedPriceableRule({ quantity: "10" });

    await materializeContributions(WINDOW);

    const holding = await only(db.select().from(holdings).where(eq(holdings.id, holdingId)));
    expect(holding.quantity).toBe("12.70000000");
  });

  it("makes contributed dollars the holding's resolved cost basis (ADR-012)", async () => {
    // The point of the whole phase: no new basis path, just lots.
    const { holdingId } = await seedPriceableRule();
    await materializeContributions(WINDOW);

    const lots = await db.select().from(holdingLots).where(eq(holdingLots.holdingId, holdingId));
    const basis = resolveCostBasis({ costBasis: null }, lots, "USD");
    expect(basis?.toString()).toBe("270.00");
  });
});

describe("materializeContributions — basis-only contribution", () => {
  beforeEach(reset);
  afterAll(reset);

  it("records dollars with no invented share count when the pay date has no price", async () => {
    const accountId = await seedAccount();
    const holdingId = await seedHolding(accountId, { quantity: "10" });
    const sourceId = await seedSource();
    await seedRule(sourceId, accountId, holdingId);
    // No `prices` row at all.

    const result = await materializeContributions(WINDOW);
    expect(result).toMatchObject({ created: 1, priceable: 0, basisOnly: 1 });

    const txn = await only(db.select().from(investmentTransactions));
    expect(txn.type).toBe("cash");
    expect(txn.subtype).toBe("deposit");
    expect(txn.source).toBe("income");
    expect(txn.quantity).toBeNull();
    expect(txn.price).toBeNull();
    expect(txn.amount).toBe("270.00"); // a deposit is cash IN

    const lot = await only(db.select().from(holdingLots));
    expect(lot.quantity).toBe("0.00000000"); // no defensible share count
    expect(lot.costBasisTotal).toBe("270.00"); // basis still accrues
    expect(lot.source).toBe("income");

    // Quantity stays the user's manual entry (ADR-031).
    const holding = await only(db.select().from(holdings).where(eq(holdings.id, holdingId)));
    expect(holding.quantity).toBe("10.00000000");
  });

  it("writes no lot when the rule designates no holding", async () => {
    const accountId = await seedAccount();
    const sourceId = await seedSource();
    await seedRule(sourceId, accountId, null);

    const result = await materializeContributions(WINDOW);
    expect(result).toMatchObject({ created: 1, basisOnly: 1 });

    expect(await db.select().from(holdingLots)).toHaveLength(0);
    const ledger = await only(db.select().from(incomeContributions));
    expect(ledger.holdingLotId).toBeNull();
    // The contribution is still recorded and still counts toward the savings rate.
    expect(ledger.employeeAmount).toBe("180.00");
    expect(ledger.investmentTransactionId).not.toBeNull();
  });
});

describe("materializeContributions — reconciliation guard (P14-12, ADR-031 §5)", () => {
  beforeEach(reset);
  afterAll(reset);

  it("never mutates Plaid- or manually-sourced transactions and lots", async () => {
    const { accountId, holdingId } = await seedPriceableRule();

    // A Plaid-synced buy and its lot, plus a hand-entered lot, all on the SAME
    // holding the income rule targets — the double-count scenario.
    await db.insert(investmentTransactions).values({
      accountId,
      type: "buy",
      tradeDate: "2025-12-15",
      quantity: "5",
      price: "90.00",
      amount: "-450.00",
      source: "plaid",
      plaidInvestmentTransactionId: "plaid-txn-1",
    });
    await db.insert(holdingLots).values([
      {
        holdingId,
        acquiredAt: "2025-12-15",
        quantity: "5",
        costBasisTotal: "450.00",
        source: "plaid",
      },
      {
        holdingId,
        acquiredAt: "2024-06-01",
        quantity: "2",
        costBasisTotal: "150.00",
        source: "manual",
      },
    ]);

    const beforeTxns = await db
      .select()
      .from(investmentTransactions)
      .where(eq(investmentTransactions.source, "plaid"));
    const beforeLots = await db.select().from(holdingLots).where(sql`source <> 'income'`);

    await materializeContributions(WINDOW);

    // Byte-identical, including updated_at — not merely still present.
    expect(
      await db
        .select()
        .from(investmentTransactions)
        .where(eq(investmentTransactions.source, "plaid")),
    ).toEqual(beforeTxns);
    expect(await db.select().from(holdingLots).where(sql`source <> 'income'`)).toEqual(beforeLots);

    // And exactly one new income row on each side.
    expect(
      await db
        .select()
        .from(investmentTransactions)
        .where(eq(investmentTransactions.source, "income")),
    ).toHaveLength(1);
    expect(
      await db.select().from(holdingLots).where(eq(holdingLots.source, "income")),
    ).toHaveLength(1);
  });

  it("leaves a Plaid-sourced holding's quantity to the sync", async () => {
    // Plaid holds quantity authoritatively; incrementing here would double-count
    // until the next sync overwrote us. The lot + transaction are still written,
    // so the contribution stays visible and auditable.
    const { holdingId } = await seedPriceableRule({ quantity: "10", source: "plaid" });

    const result = await materializeContributions(WINDOW);
    expect(result.created).toBe(1);

    const holding = await only(db.select().from(holdings).where(eq(holdings.id, holdingId)));
    expect(holding.quantity).toBe("10.00000000");
    expect(await db.select().from(holdingLots)).toHaveLength(1);
  });
});

describe("materializeContributions — inactive rules and sources", () => {
  beforeEach(reset);
  afterAll(reset);

  it("materializes nothing for an inactive rule", async () => {
    const accountId = await seedAccount();
    const holdingId = await seedHolding(accountId);
    const sourceId = await seedSource();
    await seedRule(sourceId, accountId, holdingId, { active: false });

    expect(await materializeContributions(WINDOW)).toEqual({
      rules: 0,
      created: 0,
      priceable: 0,
      basisOnly: 0,
    });
    expect(await db.select().from(incomeContributions)).toHaveLength(0);
  });

  it("materializes nothing for an inactive source", async () => {
    const accountId = await seedAccount();
    const holdingId = await seedHolding(accountId);
    const sourceId = await seedSource({ active: false });
    await seedRule(sourceId, accountId, holdingId);

    expect((await materializeContributions(WINDOW)).created).toBe(0);
  });

  it("stops materializing after the source's end date", async () => {
    const accountId = await seedAccount();
    const holdingId = await seedHolding(accountId);
    const sourceId = await seedSource({ endDate: "2026-01-01" });
    await seedRule(sourceId, accountId, holdingId);

    expect((await materializeContributions(WINDOW)).created).toBe(0);
  });
});

describe("materializeContributions — default window", () => {
  beforeEach(reset);
  afterAll(reset);

  it("looks back far enough to self-heal a missed run", async () => {
    // The worker was off for a fortnight; the next nightly run must catch up
    // without anyone reaching for the backfill.
    const accountId = await seedAccount();
    const holdingId = await seedHolding(accountId);
    const sourceId = await seedSource({ cadence: "monthly", anchorDate: "2026-03-01" });
    await seedRule(sourceId, accountId, holdingId);

    // Give the rule history first, so the short lookback — not the first-run
    // reach-back below — is what governs this run.
    await materializeContributions({ from: "2026-01-01", to: "2026-01-31" });

    const result = await materializeContributions({ now: () => new Date("2026-04-15T09:00:00Z") });

    // 45 days back from 2026-04-15 reaches 2026-03-01: both monthly pay dates.
    // 2026-02-01 stays unmaterialized — it predates the lookback, and that is
    // the backfill's job, not the nightly run's.
    const payDates = (await db.select().from(incomeContributions)).map((c) => c.payDate).sort();
    expect(payDates).toEqual(["2026-01-01", "2026-03-01", "2026-04-01"]);
    expect(result.created).toBe(2);
  });

  it("reaches back to the start date on a rule's first run", async () => {
    // The bug this guards: a paycheck defined today usually describes months of
    // contributions that already happened. Clamping the first run to the 45-day
    // lookback silently truncated them, leaving the 401k's cost basis — and the
    // savings rate — understated with no error anywhere.
    const accountId = await seedAccount();
    const holdingId = await seedHolding(accountId);
    const sourceId = await seedSource({ cadence: "monthly", anchorDate: "2026-03-01" });
    await seedRule(sourceId, accountId, holdingId);

    const result = await materializeContributions({ now: () => new Date("2026-04-15T09:00:00Z") });

    const payDates = (await db.select().from(incomeContributions)).map((c) => c.payDate).sort();
    expect(payDates).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
    expect(result.created).toBe(4);
  });

  it("still skips a paused source on its first run", async () => {
    // The reach-back widens the WINDOW; it must not weaken the active gate.
    const accountId = await seedAccount();
    const holdingId = await seedHolding(accountId);
    const sourceId = await seedSource({
      cadence: "monthly",
      anchorDate: "2026-03-01",
      active: false,
    });
    await seedRule(sourceId, accountId, holdingId);

    const result = await materializeContributions({ now: () => new Date("2026-04-15T09:00:00Z") });

    expect(result.created).toBe(0);
    expect(await db.select().from(incomeContributions)).toHaveLength(0);
  });
});
