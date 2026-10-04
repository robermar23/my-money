import type { AccountSubtype } from "@/db/schema/accounts.ts";
import type { MonthlyTotals } from "@/lib/analytics/spending.ts";
import { Money } from "@/lib/money/money.ts";
import type { KnownFutureCost } from "@/lib/sinking/types.ts";
import { type CashAccountInput, type CashTiers, classifyCashTiers } from "./cash-tiers.ts";
import type { DebtTerm, MinimumDebtService } from "./debt-terms.ts";
import type { EssentialBaseline, EssentialMonth } from "./essential-expenses.ts";
import type { ObservedNetIncome } from "./net-income.ts";
import type {
  AdviceAccount,
  AdviceCategory,
  AdviceContributionRule,
  AdviceHoldingsTotals,
  AdviceHouseholdMember,
  AdviceHouseholdProfile,
  AdviceInput,
  AdviceYtdContribution,
} from "./snapshot.ts";

/**
 * Test fixtures for {@link AdviceInput} (Phase 15, Batch 3).
 *
 * `AdviceInput` has eighteen slots. Every rule reads three or four of them and
 * needs the other fourteen to merely exist, so without a builder each rule test
 * would open with sixty lines of irrelevant scaffolding — and the one line that
 * matters would be invisible inside it.
 *
 * This is a **test-only module**. Nothing in `src/app`, `src/worker` or the rules
 * themselves imports it; it lives outside `*.test.ts` only because eight test
 * files share it. If a production module ever imports this, that is a bug.
 *
 * The defaults describe a plausible, healthy-ish household: $6,000/month
 * observed net income, $3,000/month essentials, a year of history, no debt, and
 * no household profile saved. Each test overrides the slice it is about and
 * leaves the rest alone, so a test that starts failing points at the input it
 * actually changed.
 */

/** A cash account for {@link makeCash}. */
export interface FixtureCashAccount {
  readonly name: string;
  readonly subtype: AccountSubtype | null;
  readonly balance: string;
  readonly apy?: string | null;
  readonly maturityDate?: string | null;
}

/**
 * Build real {@link CashTiers} by running the shipped classifier.
 *
 * Deliberately not a hand-written literal: a fixture that fakes the tier rollup
 * can drift from what `classifyCashTiers` actually produces, and then every rule
 * test passes against a shape the loader never emits.
 *
 * @param accounts - Cash accounts with balances.
 * @param essentialMonthly - The baseline coverage months are measured against.
 * @returns Genuine classifier output.
 */
export function makeCash(
  accounts: readonly FixtureCashAccount[],
  essentialMonthly: string | null,
): CashTiers {
  const inputs: CashAccountInput[] = accounts.map((a, i) => ({
    accountId: `cash-${i}`,
    name: a.name,
    institution: "Test Bank",
    subtype: a.subtype,
    balance: a.balance,
    apy: a.apy ?? null,
    maturityDate: a.maturityDate ?? null,
    balanceAsOf: "2026-08-01",
  }));
  return classifyCashTiers({ accounts: inputs, essentialMonthly });
}

/** A {@link DebtTerm} with sensible defaults. */
export function makeDebt(partial: Partial<DebtTerm> & { accountId: string }): DebtTerm {
  return {
    accountName: "Test card",
    institution: "Test Bank",
    kind: "revolving",
    balance: "0.00",
    apr: "0.199900",
    minimumPayment: "50.00",
    creditLimit: "5000.00",
    balanceAsOf: "2026-08-01",
    termsUpdatedAt: null,
    status: "complete",
    missing: [],
    ...partial,
  };
}

/** An {@link AdviceAccount} with sensible defaults. */
export function makeAccount(
  partial: Partial<AdviceAccount> & { accountId: string },
): AdviceAccount {
  return {
    name: "Test account",
    institution: "Test Bank",
    type: "depository",
    subtype: null,
    apy: null,
    maturityDate: null,
    taxTreatment: null,
    balance: null,
    balanceAsOf: null,
    ...partial,
  };
}

/** An {@link AdviceContributionRule} with sensible defaults. */
export function makeContributionRule(
  partial: Partial<AdviceContributionRule> & { ruleId: string },
): AdviceContributionRule {
  return {
    incomeSourceId: "src-1",
    accountId: "acct-401k",
    accountName: "401(k)",
    taxTreatment: "tax_deferred",
    employeeBasis: "percent",
    employeeValue: "6.0000",
    pretax: true,
    matchBasis: "percent_of_contribution",
    matchValue: "100.0000",
    matchCapPercent: "4.0000",
    active: true,
    ...partial,
  };
}

/** An {@link AdviceYtdContribution} with sensible defaults. */
export function makeYtd(
  partial: Partial<AdviceYtdContribution> & { ruleId: string },
): AdviceYtdContribution {
  return {
    accountId: "acct-401k",
    taxTreatment: "tax_deferred",
    employee: "0.00",
    employer: "0.00",
    gross: "0.00",
    periods: 0,
    lastPayDate: null,
    ...partial,
  };
}

/** An {@link AdviceCategory} with sensible defaults. */
export function makeCategory(
  partial: Partial<AdviceCategory> & { categoryId: string },
): AdviceCategory {
  return {
    name: "Test category",
    kind: "expense",
    necessity: null,
    excludedFromBaseline: false,
    ...partial,
  };
}

/** One month of the spend series, before the derived totals are filled in. */
export interface FixtureSpendMonth {
  /** `YYYY-MM`. */
  readonly month: string;
  /** Expense magnitude per category id. Omitted categories are zero. */
  readonly byCategory?: Record<string, string>;
  /** Income magnitude for the month. Defaults to `"0.00"`. */
  readonly income?: string;
}

/**
 * Build a {@link MonthlyTotals} series with `expense` and `net` derived rather
 * than stated.
 *
 * Same reasoning as {@link makeCash} running the real classifier: a fixture that
 * hand-writes a total which disagrees with its own per-category breakdown lets a
 * rule pass against a shape `spendByMonth` can never produce.
 *
 * @param months - Ascending months with their per-category expense.
 * @returns The gap-free series in `spendByMonth`'s shape.
 */
export function makeMonthlySpend(months: readonly FixtureSpendMonth[]): MonthlyTotals[] {
  return months.map((m) => {
    const byCategory = m.byCategory ?? {};
    const expense = Money.sum(
      Object.values(byCategory).map((v) => Money.fromString(v, "USD")),
      "USD",
    );
    const income = Money.fromString(m.income ?? "0", "USD");
    return {
      month: m.month,
      byCategory,
      income: income.toString(),
      expense: expense.toString(),
      net: income.sub(expense).toString(),
    };
  });
}

/** One month of the necessity split, before `total` is filled in. */
export interface FixtureEssentialMonth {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly essential?: string;
  readonly discretionary?: string;
  readonly savings?: string;
  readonly unclassified?: string;
}

/**
 * Build an {@link EssentialMonth} series with `total` derived from the buckets.
 *
 * @param months - Ascending months with whichever buckets the test cares about.
 * @returns The series in `computeEssentialBaseline`'s shape.
 */
export function makeEssentialMonths(
  months: readonly FixtureEssentialMonth[],
): readonly EssentialMonth[] {
  return months.map((m) => {
    const buckets = {
      essential: m.essential ?? "0.00",
      discretionary: m.discretionary ?? "0.00",
      savings: m.savings ?? "0.00",
      unclassified: m.unclassified ?? "0.00",
    };
    return {
      month: m.month,
      ...buckets,
      total: Money.sum(
        Object.values(buckets).map((v) => Money.fromString(v, "USD")),
        "USD",
      ).toString(),
    };
  });
}

/** An {@link AdviceHouseholdProfile} — every override null unless set. */
export function makeProfile(partial: Partial<AdviceHouseholdProfile> = {}): AdviceHouseholdProfile {
  return {
    reserveMonthsOverride: null,
    retirementTargetAge: null,
    benchmarkSavingsApy: null,
    needsPct: null,
    wantsPct: null,
    savingsPct: null,
    highInterestThresholdApr: null,
    currency: "USD",
    ...partial,
  };
}

/** An {@link AdviceHouseholdMember} with sensible defaults. */
export function makeMember(
  partial: Partial<AdviceHouseholdMember> & { id: string },
): AdviceHouseholdMember {
  return {
    label: "Adult",
    birthYear: 1985,
    isDependent: false,
    ...partial,
  };
}

/** The slots a test may override. Everything omitted gets a healthy default. */
export interface AdviceInputOverrides {
  readonly today?: string;
  readonly window?: { readonly from: string; readonly to: string };
  readonly historyMonths?: number;
  readonly netIncome?: Partial<ObservedNetIncome>;
  readonly essentials?: Partial<EssentialBaseline>;
  readonly cash?: CashTiers;
  readonly debts?: readonly DebtTerm[];
  readonly minimumDebtService?: MinimumDebtService;
  readonly accounts?: readonly AdviceAccount[];
  readonly contributionRules?: readonly AdviceContributionRule[];
  readonly contributionsYtd?: readonly AdviceYtdContribution[];
  readonly contributionYear?: number;
  readonly household?: {
    readonly profile?: AdviceHouseholdProfile | null;
    readonly members?: readonly AdviceHouseholdMember[];
  };
  readonly budgets?: readonly { readonly categoryId: string; readonly amount: string }[];
  readonly categories?: readonly AdviceCategory[];
  readonly monthlySpend?: readonly MonthlyTotals[];
  readonly holdings?: Partial<AdviceHoldingsTotals>;
  /**
   * The sinking-fund cost stream (P18-18). Defaults to **empty**, which is the
   * honest default for a household that has recorded nothing — and which
   * ADR-046 §5 makes a degradation rather than a pass, so a rule test that
   * forgets to pass costs fails loudly instead of quietly reporting `ok`.
   */
  readonly knownFutureCosts?: readonly KnownFutureCost[];
}

const DEFAULT_WINDOW = { from: "2025-09-01", to: "2026-08-15" } as const;

/**
 * Build a complete {@link AdviceInput} from a partial description.
 *
 * @param overrides - The slices this test is about.
 * @returns A fully-populated snapshot in the same shape `loadFinancialSnapshot`
 *   returns.
 */
export function makeAdviceInput(overrides: AdviceInputOverrides = {}): AdviceInput {
  const window = overrides.window ?? DEFAULT_WINDOW;

  const netIncome: ObservedNetIncome = {
    monthly: [],
    trailingMedian: "6000.00",
    contributingCategories: [],
    basisMonths: 12,
    windowTotal: "72000.00",
    window,
    ...overrides.netIncome,
  };

  const essentials: EssentialBaseline = {
    monthly: [],
    trailingMedian: "2700.00",
    minimumDebtService: "300.00",
    baseline: "3000.00",
    unclassifiedExpense: "0.00",
    totalExpense: "36000.00",
    unclassifiedShare: 0,
    basisMonths: 12,
    window,
    ...overrides.essentials,
  };

  const holdings: AdviceHoldingsTotals = {
    total: "0.00",
    taxable: "0.00",
    taxDeferred: "0.00",
    roth: "0.00",
    hsa: "0.00",
    unclassified: "0.00",
    ...overrides.holdings,
  };

  return {
    today: overrides.today ?? "2026-08-15",
    currency: "USD",
    window,
    historyMonths: overrides.historyMonths ?? 12,
    netIncome,
    essentials,
    cash: overrides.cash ?? makeCash([], essentials.baseline),
    debts: overrides.debts ?? [],
    minimumDebtService: overrides.minimumDebtService ?? { total: "300.00", unknownCount: 0 },
    accounts: overrides.accounts ?? [],
    contributionRules: overrides.contributionRules ?? [],
    contributionsYtd: overrides.contributionsYtd ?? [],
    contributionYear: overrides.contributionYear ?? 2026,
    household: {
      profile: overrides.household?.profile ?? null,
      members: overrides.household?.members ?? [],
    },
    budgets: overrides.budgets ?? [],
    categories: overrides.categories ?? [],
    monthlySpend: overrides.monthlySpend ?? [],
    holdings,
    knownFutureCosts: overrides.knownFutureCosts ?? [],
  };
}
