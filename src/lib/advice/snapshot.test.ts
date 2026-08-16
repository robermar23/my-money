// @vitest-environment node
import { db } from "@/db/client.ts";
import {
  accountSnapshots,
  accounts,
  categories,
  categoryBudgets,
  creditLines,
  householdMembers,
  householdProfile,
  incomeContributions,
  incomeSources,
  liabilities,
  retirementContributions,
  transactions,
} from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { loadFinancialSnapshot } from "./snapshot.ts";

/*
 * P15-12 — `loadFinancialSnapshot`, the one and only DB-reading entry point in
 * the advice layer (ADR-032 §1).
 *
 * This is an assembly test, not a math test: the arithmetic each slot contains
 * is proved by the pure-core suites (net-income, essential-expenses, cash-tiers,
 * debt-terms). What matters here is that every slot Batch 3 depends on is
 * actually populated, that the money is carried as strings, and that the two
 * cross-slot wirings are real — minimum debt service reaching the essential
 * baseline, and that baseline reaching the cash-tier coverage figures.
 */

const TODAY = "2026-08-15";

async function reset(): Promise<void> {
  await db.execute(
    sql`TRUNCATE transactions, categories, category_groups, accounts, income_sources,
        household_profile, household_members, recommendation_dismissals CASCADE`,
  );
}

beforeEach(reset);

/** A household with cash in three tiers, a mortgage, a card, income, and a 401k. */
async function seed(): Promise<{ checking: string; savings: string; cd: string }> {
  const account = async (values: typeof accounts.$inferInsert): Promise<string> => {
    const [row] = await db.insert(accounts).values(values).returning({ id: accounts.id });
    if (!row) throw new Error(`seed account ${values.name}`);
    return row.id;
  };

  const checking = await account({
    name: "Everyday",
    institution: "M&T",
    type: "depository",
    subtype: "checking",
  });
  const savings = await account({
    name: "Emergency",
    institution: "M&T",
    type: "depository",
    subtype: "savings",
    apy: "4.2000",
  });
  const cd = await account({
    name: "12-mo CD",
    institution: "M&T",
    type: "depository",
    subtype: "cd",
    maturityDate: "2027-03-01",
  });
  // Deliberately un-triaged: the loader must carry it through as unclassified.
  const untriaged = await account({ name: "Old savings", institution: "M&T", type: "depository" });
  const card = await account({ name: "Card", institution: "Citi", type: "credit_card" });
  const loan = await account({ name: "Home Loan", institution: "Sunwest", type: "loan" });
  const four01k = await account({
    name: "401k",
    institution: "Fidelity",
    type: "investment",
    taxTreatment: "tax_deferred",
  });
  const brokerage = await account({
    name: "Brokerage",
    institution: "Fidelity",
    type: "investment",
    taxTreatment: "taxable",
  });
  // A closed account must not appear anywhere in the snapshot.
  const closed = await account({
    name: "Closed checking",
    institution: "Old Bank",
    type: "depository",
    subtype: "checking",
    closedAt: new Date("2026-01-01T00:00:00Z"),
  });

  await db.insert(accountSnapshots).values([
    // Two snapshots for checking — only the latest must win.
    { accountId: checking, date: "2026-07-01", balance: "1000.00" },
    { accountId: checking, date: "2026-08-01", balance: "4200.00" },
    { accountId: savings, date: "2026-08-01", balance: "12000.00" },
    { accountId: cd, date: "2026-08-01", balance: "10000.00" },
    { accountId: untriaged, date: "2026-08-01", balance: "3000.00" },
    { accountId: card, date: "2026-08-10", balance: "-2400.00" },
    { accountId: loan, date: "2026-08-01", balance: "-180500.00" },
    { accountId: four01k, date: "2026-08-01", balance: "150000.00" },
    { accountId: brokerage, date: "2026-08-01", balance: "50000.00" },
    { accountId: closed, date: "2026-08-01", balance: "9999.00" },
  ]);

  await db.insert(liabilities).values({
    accountId: loan,
    name: "Mortgage",
    principalAtOrigination: "200000.00",
    annualRate: "0.060000",
    termMonths: 360,
    startDate: "2020-08-15",
  });
  await db.insert(creditLines).values({
    accountId: card,
    apr: "0.249900",
    creditLimit: "15000.00",
    minimumPayment: "35.00",
  });

  const [salary] = await db
    .insert(categories)
    .values({ name: "Salary", kind: "income" })
    .returning({ id: categories.id });
  const [rent] = await db
    .insert(categories)
    .values({ name: "Rent", kind: "expense", necessity: "essential" })
    .returning({ id: categories.id });
  const [dining] = await db
    .insert(categories)
    .values({ name: "Dining", kind: "expense", necessity: "discretionary" })
    .returning({ id: categories.id });
  if (!salary || !rent || !dining) throw new Error("seed categories");

  let fit = 0;
  const rows: (typeof transactions.$inferInsert)[] = [];
  for (const month of ["2026-06", "2026-07", "2026-08"]) {
    rows.push(
      {
        accountId: checking,
        postedAt: `${month}-01`,
        amount: "5000.00",
        name: "pay",
        fitid: `f${fit++}`,
        source: "manual",
        categoryId: salary.id,
      },
      {
        accountId: checking,
        postedAt: `${month}-02`,
        amount: "-1800.00",
        name: "rent",
        fitid: `f${fit++}`,
        source: "manual",
        categoryId: rent.id,
      },
      {
        accountId: card,
        postedAt: `${month}-05`,
        amount: "-300.00",
        name: "dinner",
        fitid: `f${fit++}`,
        source: "manual",
        categoryId: dining.id,
      },
    );
  }
  await db.insert(transactions).values(rows);

  await db.insert(categoryBudgets).values({ categoryId: dining.id, amount: "250.00" });

  const [source] = await db
    .insert(incomeSources)
    .values({
      name: "Acme",
      cadence: "biweekly",
      grossPerPeriod: "3000.00",
      anchorDate: "2026-01-02",
      startDate: "2026-01-01",
    })
    .returning({ id: incomeSources.id });
  if (!source) throw new Error("seed income source");

  const [rule] = await db
    .insert(retirementContributions)
    .values({
      incomeSourceId: source.id,
      accountId: four01k,
      employeeBasis: "percent",
      employeeValue: "10.0000",
      matchBasis: "percent_of_gross",
      matchValue: "4.0000",
      matchCapPercent: "4.0000",
    })
    .returning({ id: retirementContributions.id });
  if (!rule) throw new Error("seed rule");

  await db.insert(incomeContributions).values([
    // Two pay dates this year...
    {
      retirementContributionId: rule.id,
      payDate: "2026-01-02",
      grossAmount: "3000.00",
      employeeAmount: "300.00",
      employerAmount: "120.00",
    },
    {
      retirementContributionId: rule.id,
      payDate: "2026-01-16",
      grossAmount: "3000.00",
      employeeAmount: "300.00",
      employerAmount: "120.00",
    },
    // ...and one from LAST year, which must not be counted toward this year's
    // statutory limit (P15-21 keys pacing on `pay_date`, not `created_at`).
    {
      retirementContributionId: rule.id,
      payDate: "2025-12-19",
      grossAmount: "3000.00",
      employeeAmount: "300.00",
      employerAmount: "120.00",
    },
  ]);

  await db.insert(householdProfile).values({ reserveMonthsOverride: 6, currency: "USD" });
  await db.insert(householdMembers).values([
    { label: "Adult", birthYear: 1985 },
    { label: "Kid", birthYear: 2018, isDependent: true },
  ]);

  return { checking, savings, cd };
}

describe("loadFinancialSnapshot", () => {
  it("assembles every slot the rules engine reads", async () => {
    await seed();
    const input = await loadFinancialSnapshot({ today: TODAY, windowMonths: 3 });

    expect(input.today).toBe(TODAY);
    expect(input.currency).toBe("USD");
    expect(input.window).toEqual({ from: "2026-06-01", to: "2026-08-15" });
    expect(input.contributionYear).toBe(2026);

    // Observed net income: $5,000 in each of three months.
    expect(input.netIncome.trailingMedian).toBe("5000.00");
    expect(input.netIncome.contributingCategories.map((c) => c.name)).toEqual(["Salary"]);

    // Essential expenses: $1,800 rent + minimum debt service.
    expect(input.essentials.trailingMedian).toBe("1800.00");
    expect(input.essentials.unclassifiedShare).toBe(0);

    // Household + budgets.
    expect(input.household.profile?.reserveMonthsOverride).toBe(6);
    expect(input.household.members.map((m) => m.label)).toEqual(["Adult", "Kid"]);
    expect(input.household.members.find((m) => m.label === "Kid")?.isDependent).toBe(true);
    expect(input.budgets).toEqual([{ categoryId: expect.any(String), amount: "250.00" }]);

    // History depth — the ADR-034 §7 gating input.
    expect(input.historyMonths).toBe(2); // 2026-06 → 2026-08
  });

  it("wires minimum debt service into the baseline and the baseline into cash coverage", async () => {
    await seed();
    const input = await loadFinancialSnapshot({ today: TODAY, windowMonths: 3 });

    // Mortgage P+I ($1,199.10) + the card's flat minimum ($35.00).
    expect(input.minimumDebtService).toEqual({ total: "1234.10", unknownCount: 0 });

    // The mortgage payment is essential but lives in `liabilities`, not in a
    // spend category — this is the wiring that makes it visible at all.
    expect(input.essentials.minimumDebtService).toBe("1234.10");
    expect(input.essentials.baseline).toBe("3034.10");

    // ...and the tier coverage is measured against that same figure.
    expect(input.cash.essentialMonthly).toBe("3034.10");
    expect(input.cash.reserve.monthsCovered).toBe("3.96"); // 12000 / 3034.10
  });

  it("tiers cash by subtype and leaves an un-triaged account unclassified", async () => {
    await seed();
    const input = await loadFinancialSnapshot({ today: TODAY, windowMonths: 3 });

    expect(input.cash.operating.total).toBe("4200.00"); // latest snapshot, not the 1000
    expect(input.cash.reserve.total).toBe("12000.00");
    expect(input.cash.mediumTerm.total).toBe("10000.00");
    expect(input.cash.unclassified.total).toBe("3000.00");
    // The CD is excluded from liquid; so is the account we cannot classify.
    expect(input.cash.liquid).toBe("16200.00");
  });

  it("unions both debt tables, largest balance first", async () => {
    await seed();
    const input = await loadFinancialSnapshot({ today: TODAY, windowMonths: 3 });

    expect(input.debts.map((d) => d.kind)).toEqual(["amortizing", "revolving"]);
    expect(input.debts[0]).toMatchObject({ balance: "180500.00", apr: "0.060000" });
    expect(input.debts[1]).toMatchObject({
      balance: "2400.00",
      apr: "0.249900",
      creditLimit: "15000.00",
      status: "complete",
    });
  });

  it("keys YTD contributions on pay_date, excluding last year's", async () => {
    await seed();
    const input = await loadFinancialSnapshot({ today: TODAY, windowMonths: 3 });

    expect(input.contributionsYtd).toHaveLength(1);
    expect(input.contributionsYtd[0]).toMatchObject({
      employee: "600.00", // two 2026 pay dates, not three
      employer: "240.00",
      periods: 2,
      lastPayDate: "2026-01-16",
      taxTreatment: "tax_deferred",
    });

    expect(input.contributionRules).toHaveLength(1);
    expect(input.contributionRules[0]).toMatchObject({
      matchBasis: "percent_of_gross",
      matchCapPercent: "4.0000",
      taxTreatment: "tax_deferred",
      active: true,
    });
  });

  it("buckets investable balances by tax container", async () => {
    await seed();
    const input = await loadFinancialSnapshot({ today: TODAY, windowMonths: 3 });

    expect(input.holdings).toMatchObject({
      total: "200000.00",
      taxDeferred: "150000.00",
      taxable: "50000.00",
      roth: "0.00",
      hsa: "0.00",
      unclassified: "0.00",
    });
  });

  it("excludes closed accounts from every slot", async () => {
    await seed();
    const input = await loadFinancialSnapshot({ today: TODAY, windowMonths: 3 });

    expect(input.accounts.map((a) => a.name)).not.toContain("Closed checking");
    // Its $9,999 must not inflate the operating tier.
    expect(input.cash.operating.total).toBe("4200.00");
  });

  it("returns a usable, all-null-baseline snapshot on a fresh install", async () => {
    const input = await loadFinancialSnapshot({ today: TODAY, windowMonths: 3 });

    // Nothing throws, nothing is NaN, and nothing claims to know a figure it
    // does not — this is the state every rule's gating must survive.
    expect(input.historyMonths).toBe(0);
    expect(input.netIncome.trailingMedian).toBeNull();
    expect(input.essentials.baseline).toBeNull();
    expect(input.cash.total).toBe("0.00");
    expect(input.cash.liquidMonthsCovered).toBeNull();
    expect(input.debts).toEqual([]);
    expect(input.minimumDebtService).toEqual({ total: "0.00", unknownCount: 0 });
    expect(input.household.profile).toBeNull();
    expect(input.household.members).toEqual([]);
    expect(input.holdings.total).toBe("0.00");
  });
});
