// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accounts,
  holdingLots,
  holdings,
  incomeContributions,
  incomeSources,
  retirementContributions,
} from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  countMaterializedContributions,
  listAccountContributions,
  loadIncomeSettings,
  savingsRateInputs,
} from "./queries.ts";

/**
 * P14-14 — the read model behind `/settings/income`.
 *
 * The load-bearing assertions here are the two things the page cannot get wrong
 * without misleading the user about their own money: the materialization tally
 * (how much basis this rule has actually produced) and the Plaid double-count
 * flag (ADR-031 §5 — the same dollars counted twice).
 */

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE income_contributions, retirement_contributions, income_sources,
        investment_transactions, holding_lots, holdings, accounts CASCADE`,
  );
}

interface Seed {
  readonly sourceId: string;
  readonly ruleId: string;
  readonly investmentId: string;
  readonly holdingId: string;
}

/** A 401k with one holding, a paycheck, and the rule that connects them. */
async function seed(): Promise<Seed> {
  const [investment] = await db
    .insert(accounts)
    .values({ name: "401k", institution: "Fidelity", type: "investment", currency: "USD" })
    .returning({ id: accounts.id });
  // A non-investment account and its holding must never reach the pickers.
  await db
    .insert(accounts)
    .values({ name: "Checking", institution: "Ally", type: "depository", currency: "USD" });
  if (!investment) throw new Error("seed account failed");

  const [holding] = await db
    .insert(holdings)
    .values({
      accountId: investment.id,
      symbol: "FXAIX",
      quantity: "0",
      quantityUnit: "shares",
      assetClass: "equity",
    })
    .returning({ id: holdings.id });
  if (!holding) throw new Error("seed holding failed");

  const [source] = await db
    .insert(incomeSources)
    .values({
      name: "Acme Corp",
      cadence: "biweekly",
      grossPerPeriod: "3000.00",
      anchorDate: "2026-01-02",
      startDate: "2026-01-01",
    })
    .returning({ id: incomeSources.id });
  if (!source) throw new Error("seed source failed");

  const [rule] = await db
    .insert(retirementContributions)
    .values({
      incomeSourceId: source.id,
      accountId: investment.id,
      holdingId: holding.id,
      employeeBasis: "percent",
      employeeValue: "6",
      matchBasis: "percent_of_gross",
      matchValue: "3",
    })
    .returning({ id: retirementContributions.id });
  if (!rule) throw new Error("seed rule failed");

  return {
    sourceId: source.id,
    ruleId: rule.id,
    investmentId: investment.id,
    holdingId: holding.id,
  };
}

/** Two materialized pay dates, as the job would have written them. */
async function seedContributions(ruleId: string): Promise<void> {
  await db.insert(incomeContributions).values([
    {
      retirementContributionId: ruleId,
      payDate: "2026-01-02",
      grossAmount: "3000.00",
      employeeAmount: "180.00",
      employerAmount: "90.00",
    },
    {
      retirementContributionId: ruleId,
      payDate: "2026-01-16",
      grossAmount: "3000.00",
      employeeAmount: "180.00",
      employerAmount: "90.00",
    },
  ]);
}

describe("loadIncomeSettings", () => {
  beforeEach(reset);
  afterAll(reset);

  it("returns each source with its rule attached", async () => {
    const { sourceId, holdingId } = await seed();

    const settings = await loadIncomeSettings();
    expect(settings.sources).toHaveLength(1);
    const source = settings.sources[0];
    expect(source?.id).toBe(sourceId);
    expect(source?.rule?.holdingId).toBe(holdingId);
    expect(source?.rule?.accountName).toBe("401k");
    expect(source?.rule?.holdingSymbol).toBe("FXAIX");
  });

  it("reports zeroes for a rule the job has not run for yet", async () => {
    await seed();

    const settings = await loadIncomeSettings();
    const rule = settings.sources[0]?.rule;
    expect(rule?.materializedCount).toBe(0);
    expect(rule?.lastPayDate).toBeNull();
    expect(rule?.totalEmployee).toBe("0");
  });

  it("tallies materialized contributions to date", async () => {
    const { ruleId } = await seed();
    await seedContributions(ruleId);

    const settings = await loadIncomeSettings();
    const rule = settings.sources[0]?.rule;
    expect(rule?.materializedCount).toBe(2);
    expect(rule?.lastPayDate).toBe("2026-01-16");
    expect(rule?.totalEmployee).toBe("360.00");
    expect(rule?.totalEmployer).toBe("180.00");
  });

  it("offers only investment accounts and their holdings", async () => {
    await seed();

    const settings = await loadIncomeSettings();
    expect(settings.investmentAccounts.map((a) => a.name)).toEqual(["401k"]);
    expect(settings.holdings.map((h) => h.symbol)).toEqual(["FXAIX"]);
  });

  it("flags a holding that already carries Plaid lots", async () => {
    // The double-count case (ADR-031 §5): the sync and the contribution rule
    // would each add basis for the same dollars. The UI warns on this flag.
    const { holdingId } = await seed();
    await db.insert(holdingLots).values({
      holdingId,
      acquiredAt: "2025-12-01",
      quantity: "1.00000000",
      costBasisTotal: "100.00",
      source: "plaid",
    });

    const settings = await loadIncomeSettings();
    expect(settings.holdings[0]?.hasPlaidLots).toBe(true);
  });

  it("does not flag a holding whose lots came from contributions or manual entry", async () => {
    const { holdingId } = await seed();
    await db.insert(holdingLots).values([
      {
        holdingId,
        acquiredAt: "2026-01-02",
        quantity: "1.00000000",
        costBasisTotal: "270.00",
        source: "income",
      },
      {
        holdingId,
        acquiredAt: "2025-06-01",
        quantity: "2.00000000",
        costBasisTotal: "500.00",
        source: "manual",
      },
    ]);

    const settings = await loadIncomeSettings();
    expect(settings.holdings[0]?.hasPlaidLots).toBe(false);
  });
});

describe("countMaterializedContributions", () => {
  beforeEach(reset);
  afterAll(reset);

  it("counts by rule and by source alike", async () => {
    const { sourceId, ruleId } = await seed();
    await seedContributions(ruleId);

    expect(await countMaterializedContributions({ ruleId })).toBe(2);
    expect(await countMaterializedContributions({ sourceId })).toBe(2);
  });

  it("returns zero for a source with no rule at all", async () => {
    const [source] = await db
      .insert(incomeSources)
      .values({
        name: "Side gig",
        cadence: "monthly",
        grossPerPeriod: "500.00",
        anchorDate: "2026-01-01",
        startDate: "2026-01-01",
      })
      .returning({ id: incomeSources.id });

    expect(await countMaterializedContributions({ sourceId: source?.id ?? "" })).toBe(0);
  });
});

describe("savingsRateInputs", () => {
  beforeEach(reset);
  afterAll(reset);

  it("windows contributions at the database and returns sources whole", async () => {
    const { ruleId } = await seed();
    await seedContributions(ruleId); // 2026-01-02 and 2026-01-16
    await db.insert(incomeContributions).values({
      retirementContributionId: ruleId,
      payDate: "2025-06-01", // outside the window below
      grossAmount: "3000.00",
      employeeAmount: "999.00",
      employerAmount: "0.00",
    });

    const inputs = await savingsRateInputs({ from: "2026-01-01", to: "2026-06-30" });
    expect(inputs.contributions).toHaveLength(2);
    expect(inputs.contributions.map((c) => c.employeeAmount)).toEqual(["180.00", "180.00"]);
    expect(inputs.sources).toHaveLength(1);
    expect(inputs.sources[0]).toMatchObject({
      cadence: "biweekly",
      grossPerPeriod: "3000.00",
      active: true,
    });
  });

  it("includes the window's boundary dates", async () => {
    // `between` is inclusive; a pay date landing exactly on the boundary is a
    // real contribution and dropping it would understate the rate.
    const { ruleId } = await seed();
    await seedContributions(ruleId);

    const inputs = await savingsRateInputs({ from: "2026-01-02", to: "2026-01-16" });
    expect(inputs.contributions).toHaveLength(2);
  });

  it("returns inactive sources too, so the card can tell paused from undefined", async () => {
    await seed();
    await db.update(incomeSources).set({ active: false });

    const inputs = await savingsRateInputs({ from: "2026-01-01", to: "2026-12-31" });
    expect(inputs.sources).toHaveLength(1);
    expect(inputs.sources[0]?.active).toBe(false);
  });
});

describe("listAccountContributions", () => {
  beforeEach(reset);
  afterAll(reset);

  it("lists the account's contributions newest first, with the paycheck name", async () => {
    const { ruleId, investmentId } = await seed();
    await seedContributions(ruleId);

    const rows = await listAccountContributions(investmentId);
    expect(rows.map((r) => r.payDate)).toEqual(["2026-01-16", "2026-01-02"]);
    expect(rows[0]?.sourceName).toBe("Acme Corp");
    expect(rows[0]?.employeeAmount).toBe("180.00");
    expect(rows[0]?.employerAmount).toBe("90.00");
  });

  it("returns nothing for an account no rule funds", async () => {
    const { ruleId } = await seed();
    await seedContributions(ruleId);
    const [other] = await db
      .insert(accounts)
      .values({ name: "Brokerage", institution: "Vanguard", type: "investment", currency: "USD" })
      .returning({ id: accounts.id });

    expect(await listAccountContributions(other?.id ?? "")).toEqual([]);
  });

  it("caps the ledger at the requested limit", async () => {
    const { ruleId, investmentId } = await seed();
    await seedContributions(ruleId);

    const rows = await listAccountContributions(investmentId, 1);
    // The cap keeps the newest, not an arbitrary page.
    expect(rows.map((r) => r.payDate)).toEqual(["2026-01-16"]);
  });
});
