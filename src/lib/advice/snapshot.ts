import "server-only";

import { db } from "@/db/client.ts";
import type { AccountSubtype, AccountTaxTreatment } from "@/db/schema/accounts.ts";
import type { CategoryKind, CategoryNecessity } from "@/db/schema/categories.ts";
import {
  accounts,
  categories,
  categoryBudgets,
  creditLines,
  householdMembers,
  householdProfile,
  incomeContributions,
  liabilities,
  retirementContributions,
  transactions,
} from "@/db/schema/index.ts";
import type { EmployeeContributionBasis, EmployerMatchBasis } from "@/db/schema/index.ts";
import { type MonthlyTotals, spendByMonth } from "@/lib/analytics/spending.ts";
import { Money } from "@/lib/money/money.ts";
import { monthsBetween } from "@/lib/schedule/occurrences.ts";
import { loadKnownFutureCosts } from "@/lib/sinking/queries.ts";
import type { KnownFutureCost } from "@/lib/sinking/types.ts";
import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { type CashAccountInput, type CashTiers, classifyCashTiers } from "./cash-tiers.ts";
import {
  type DebtTerm,
  type MinimumDebtService,
  latestBalances,
  totalMinimumDebtService,
  unifyDebtTermsFrom,
} from "./debt-terms.ts";
import { type EssentialBaseline, essentialMonthlyBaseline } from "./essential-expenses.ts";
import { type ObservedNetIncome, observedNetIncome } from "./net-income.ts";

/**
 * `loadFinancialSnapshot` — **the one and only DB-reading entry point in the
 * advice layer** (Phase 15, PLAN15 P15-12, ADR-032 §1).
 *
 * This is ADR-029's "the loader is smart, the cards are dumb" applied to
 * guidance. Every rule in Batch 3 is a pure function `(input: AdviceInput) =>
 * Recommendation[]`; none of them imports `db`, and none of them can. That is
 * what makes the entire prescriptive surface unit-testable without a database,
 * offline, and auditable — the property ADR-032 is built around.
 *
 * The three sibling modules that also touch the database
 * ([net-income](./net-income.ts), [essential-expenses](./essential-expenses.ts),
 * [debt-terms](./debt-terms.ts)) are ingredients of *this* function, not
 * alternative entry points: each is a thin query wrapper around a pure core, and
 * this loader is the only caller in the advice path. A rule that reaches past
 * `AdviceInput` for its own read is the one thing this design forbids.
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────
 *   - **No savings rate.** Exactly one exists and PLAN14 already shipped it
 *     (ADR-034 §2, [savings-rate.ts](../income/savings-rate.ts)). Recomputing it
 *     here would put two disagreeing rates on one screen, which reads as a bug
 *     even when both are right. `netIncome` is a *different* figure under a
 *     different name.
 *   - **No recommendations.** They are computed on read and never stored
 *     (ADR-032 §3). This assembles inputs only.
 *   - **No egress.** Nothing in this module or anything it imports makes an
 *     outbound request. Every benchmark constant is checked into the repo
 *     (PLAN15 §Privacy — binding). A Batch-7 regression test enforces it.
 *   - **No logging of figures.** No income, balance, or recommendation value is
 *     ever written to a log line (CLAUDE.md §Privacy).
 *
 * Money discipline (CLAUDE.md §Money): every dollar in `AdviceInput` is a
 * `numeric` string. No `Number()` appears in the advice layer at all; the
 * display-edge conversion happens in the Recharts islands.
 */

const CURRENCY = "USD";

/** How many trailing months of history the baselines are computed over. */
const DEFAULT_WINDOW_MONTHS = 12;

/** An account as the rules see it — the Phase-15 columns plus identity. */
export interface AdviceAccount {
  readonly accountId: string;
  readonly name: string;
  readonly institution: string;
  readonly type: string;
  readonly subtype: AccountSubtype | null;
  /** Percentage ("4.5000" = 4.5%). */
  readonly apy: string | null;
  readonly maturityDate: string | null;
  /** Container label for waterfall ORDERING only — drives no math (ADR-032 §4). */
  readonly taxTreatment: AccountTaxTreatment | null;
  /** Latest snapshot balance, signed as stored. `null` when never snapshotted. */
  readonly balance: string | null;
  readonly balanceAsOf: string | null;
}

/** A contribution rule, joined to the container it funds. */
export interface AdviceContributionRule {
  readonly ruleId: string;
  readonly incomeSourceId: string;
  readonly accountId: string;
  readonly accountName: string;
  /** The funded account's tax container — how the waterfall orders it. */
  readonly taxTreatment: AccountTaxTreatment | null;
  readonly employeeBasis: EmployeeContributionBasis;
  readonly employeeValue: string;
  readonly pretax: boolean;
  readonly matchBasis: EmployerMatchBasis;
  readonly matchValue: string;
  /** Employer match ceiling as a % of gross; `null` = uncapped. */
  readonly matchCapPercent: string | null;
  readonly active: boolean;
}

/** Year-to-date materialized contributions for one rule. */
export interface AdviceYtdContribution {
  readonly ruleId: string;
  readonly accountId: string;
  readonly taxTreatment: AccountTaxTreatment | null;
  /** The employee's own dollars — what a statutory elective-deferral limit caps. */
  readonly employee: string;
  /** Employer dollars — a separate limit, never folded into the employee figure. */
  readonly employer: string;
  readonly gross: string;
  /** How many pay dates are behind these totals. */
  readonly periods: number;
  /** The most recent pay date counted, for pacing projections (P15-21). */
  readonly lastPayDate: string | null;
}

/** The household profile, with every override left exactly as stored. */
export interface AdviceHouseholdProfile {
  readonly reserveMonthsOverride: number | null;
  readonly retirementTargetAge: number | null;
  /** Percentage ("4.5000" = 4.5%). */
  readonly benchmarkSavingsApy: string | null;
  /** All three set together or all three null (enforced by CHECK). */
  readonly needsPct: string | null;
  readonly wantsPct: string | null;
  readonly savingsPct: string | null;
  /** Decimal FRACTION ("0.070000" = 7%). */
  readonly highInterestThresholdApr: string | null;
  readonly currency: string;
}

/** One person in the household. */
export interface AdviceHouseholdMember {
  readonly id: string;
  readonly label: string;
  readonly birthYear: number | null;
  readonly isDependent: boolean;
}

/**
 * A spend category as the budget rules see it (Batch 4).
 *
 * Only the columns the rules read: the name they render, the `kind` that keeps
 * transfers out of every total (ADR-018), and the two Phase-15 columns. Archived
 * categories are excluded by the query — a category the user retired should not
 * generate a "you have no budget for this" nag forever.
 */
export interface AdviceCategory {
  readonly categoryId: string;
  readonly name: string;
  readonly kind: CategoryKind;
  /** `null` = unclassified. Never defaulted — see [categories.ts](../../db/schema/categories.ts). */
  readonly necessity: CategoryNecessity | null;
  readonly excludedFromBaseline: boolean;
}

/** Investable balances bucketed by tax container (ADR-034 §4 ordering input). */
export interface AdviceHoldingsTotals {
  readonly total: string;
  readonly taxable: string;
  readonly taxDeferred: string;
  readonly roth: string;
  readonly hsa: string;
  /** Investment accounts with no `tax_treatment` set — cannot be ordered. */
  readonly unclassified: string;
}

/**
 * Everything the rules engine reads. Fully assembled, typed, money-as-strings.
 *
 * This is the ADR-032 §1 contract. Batch 3's `Rule.evaluate` takes exactly this
 * and nothing else.
 */
export interface AdviceInput {
  /** Reference date, `YYYY-MM-DD`. Injected so every rule is deterministic. */
  readonly today: string;
  readonly currency: string;
  /** The trailing window the baselines were computed over. */
  readonly window: { readonly from: string; readonly to: string };
  /**
   * Months between the earliest transaction and `today` — the depth figure
   * behind ADR-034 §7's per-rule `minMonthsHistory` gating (P15-13/P15-23). A
   * two-month-old install must not confidently recommend budgets, and this is
   * what lets the engine know it is two months old.
   */
  readonly historyMonths: number;
  readonly netIncome: ObservedNetIncome;
  readonly essentials: EssentialBaseline;
  readonly cash: CashTiers;
  readonly debts: readonly DebtTerm[];
  readonly minimumDebtService: MinimumDebtService;
  readonly accounts: readonly AdviceAccount[];
  readonly contributionRules: readonly AdviceContributionRule[];
  readonly contributionsYtd: readonly AdviceYtdContribution[];
  /** The year `contributionsYtd` covers — the key for `limitsForYear` (P15-14). */
  readonly contributionYear: number;
  readonly household: {
    /** `null` until the user saves the singleton; every rule falls back to a default. */
    readonly profile: AdviceHouseholdProfile | null;
    readonly members: readonly AdviceHouseholdMember[];
  };
  /** Stored monthly targets, for the budget-coverage rule (P15-25). */
  readonly budgets: readonly { readonly categoryId: string; readonly amount: string }[];
  /** Active categories, for the budget rules to name and classify (Batch 4). */
  readonly categories: readonly AdviceCategory[];
  /**
   * Gap-free ascending monthly spend across the window, broken out by category —
   * the same {@link spendByMonth} series the analysis pages render (Batch 4).
   *
   * Reused rather than re-aggregated on purpose: a budget suggestion computed
   * from a second, subtly different spend query would disagree with the number
   * on the budgets page, and a user comparing the two would be right to distrust
   * both. `essentials.monthly` is the *necessity* split of the same underlying
   * transactions; this is the *category* split.
   */
  readonly monthlySpend: readonly MonthlyTotals[];
  readonly holdings: AdviceHoldingsTotals;
  /**
   * Dated costs the household already knows about, over the next
   * `SINKING_HORIZON_MONTHS` (Phase 18, P18-18, ADR-045 §7).
   *
   * **Assembled here precisely so the `sinking_fund` rule stays I/O-free**
   * (ADR-032 §1). The alternative — a rule that reads `planned_expenses`
   * itself — is the one thing this design forbids, and it would cost the rule
   * its whole test surface: every case in
   * [sinking-fund.test.ts](./rules/sinking-fund.test.ts) runs with no database
   * because the costs arrive on this field.
   *
   * Already filtered and ordered by the pure `buildCostStream`
   * ([sinking/costs.ts](../sinking/costs.ts)), so nothing downstream re-decides
   * which costs are in the horizon. Empty on a fresh install, which ADR-046 §5
   * makes a **degradation** rather than a pass — see
   * [sinking/status.ts](../sinking/status.ts).
   */
  readonly knownFutureCosts: readonly KnownFutureCost[];
}

/** First day of the month `monthsBack` whole months before `today`. */
function windowStart(today: string, monthsBack: number): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const d = new Date(Date.UTC(year, month - 1 - monthsBack, 1));
  return d.toISOString().slice(0, 10);
}

export interface LoadSnapshotOptions {
  /** Reference date, `YYYY-MM-DD`. Defaults to the current UTC date. */
  readonly today?: string;
  /** Trailing months the baselines cover. Default 12. */
  readonly windowMonths?: number;
}

/**
 * Assemble the complete `AdviceInput` (P15-12).
 *
 * Ordering matters in one place and only one: the essential baseline folds in
 * minimum debt service, so debt terms are resolved first. Everything else runs
 * concurrently.
 *
 * @param options - Reference date and window depth, both injected for tests.
 * @returns The fully-assembled, money-as-strings snapshot every rule consumes.
 */
export async function loadFinancialSnapshot(
  options: LoadSnapshotOptions = {},
): Promise<AdviceInput> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const windowMonths = Math.max(1, Math.floor(options.windowMonths ?? DEFAULT_WINDOW_MONTHS));
  const window = { from: windowStart(today, windowMonths - 1), to: today };
  const contributionYear = Number(today.slice(0, 4));

  // ── Pass 1: accounts, and everything that does not depend on them ────────
  const [
    accountRows,
    profileRow,
    memberRows,
    budgetRows,
    categoryRows,
    monthlySpend,
    ruleRows,
    ytdRows,
    earliest,
    knownFutureCosts,
  ] = await Promise.all([
    db
      .select({
        accountId: accounts.id,
        name: accounts.name,
        institution: accounts.institution,
        type: accounts.type,
        subtype: accounts.subtype,
        apy: accounts.apy,
        maturityDate: accounts.maturityDate,
        taxTreatment: accounts.taxTreatment,
      })
      .from(accounts)
      // Closed accounts hold no live balance and belong to no tier.
      .where(isNull(accounts.closedAt))
      .orderBy(asc(accounts.name)),
    db.select().from(householdProfile).limit(1),
    db
      .select({
        id: householdMembers.id,
        label: householdMembers.label,
        birthYear: householdMembers.birthYear,
        isDependent: householdMembers.isDependent,
      })
      .from(householdMembers)
      .orderBy(asc(householdMembers.createdAt)),
    db
      .select({ categoryId: categoryBudgets.categoryId, amount: categoryBudgets.amount })
      .from(categoryBudgets),
    db
      .select({
        categoryId: categories.id,
        name: categories.name,
        kind: categories.kind,
        necessity: categories.necessity,
        excludedFromBaseline: categories.excludedFromBaseline,
      })
      .from(categories)
      // Archived categories keep their history but generate no advice.
      .where(isNull(categories.archivedAt))
      .orderBy(asc(categories.name)),
    spendByMonth(window),
    db
      .select({
        ruleId: retirementContributions.id,
        incomeSourceId: retirementContributions.incomeSourceId,
        accountId: retirementContributions.accountId,
        accountName: accounts.name,
        taxTreatment: accounts.taxTreatment,
        employeeBasis: retirementContributions.employeeBasis,
        employeeValue: retirementContributions.employeeValue,
        pretax: retirementContributions.pretax,
        matchBasis: retirementContributions.matchBasis,
        matchValue: retirementContributions.matchValue,
        matchCapPercent: retirementContributions.matchCapPercent,
        active: retirementContributions.active,
      })
      .from(retirementContributions)
      .innerJoin(accounts, eq(accounts.id, retirementContributions.accountId))
      .orderBy(asc(retirementContributions.createdAt)),
    // YTD is keyed on `pay_date`, not `created_at`: a backfilled contribution
    // belongs to the year it was PAID, which is the year a statutory limit
    // applies to (P15-21).
    db
      .select({
        ruleId: incomeContributions.retirementContributionId,
        accountId: retirementContributions.accountId,
        taxTreatment: accounts.taxTreatment,
        employee: sql<string>`sum(${incomeContributions.employeeAmount})`,
        employer: sql<string>`sum(${incomeContributions.employerAmount})`,
        gross: sql<string>`sum(${incomeContributions.grossAmount})`,
        periods: sql<number>`count(*)::int`,
        lastPayDate: sql<string>`max(${incomeContributions.payDate})`,
      })
      .from(incomeContributions)
      .innerJoin(
        retirementContributions,
        eq(retirementContributions.id, incomeContributions.retirementContributionId),
      )
      .innerJoin(accounts, eq(accounts.id, retirementContributions.accountId))
      .where(
        and(
          gte(incomeContributions.payDate, `${contributionYear}-01-01`),
          lte(incomeContributions.payDate, `${contributionYear}-12-31`),
        ),
      )
      .groupBy(
        incomeContributions.retirementContributionId,
        retirementContributions.accountId,
        accounts.taxTreatment,
      ),
    db.select({ earliest: sql<string | null>`min(${transactions.postedAt})` }).from(transactions),
    // Phase 18. In pass 1 because it depends on nothing else here — the cost
    // stream is read straight off `planned_expenses` and the occurrence
    // calendar, neither of which waits on balances or the essential baseline.
    loadKnownFutureCosts(today),
  ]);

  // ── Pass 2: balances, then the debt/cash/baseline chain ──────────────────
  const balanceRows = await latestBalances(accountRows.map((a) => a.accountId));
  const balanceByAccount = new Map(balanceRows.map((b) => [b.accountId, b]));

  const debtAccountIds = new Set(
    accountRows
      .filter((a) => a.type === "loan" || a.type === "credit_card")
      .map((a) => a.accountId),
  );
  const [liabilityRows, creditLineRows] = await Promise.all([
    debtLiabilities([...debtAccountIds]),
    debtCreditLines([...debtAccountIds]),
  ]);

  const debts = unifyDebtTermsFrom(
    {
      accounts: accountRows.map((a) => ({
        id: a.accountId,
        name: a.name,
        institution: a.institution,
        type: a.type,
      })),
      liabilities: liabilityRows,
      creditLines: creditLineRows,
      latestBalances: balanceRows,
    },
    today,
  );
  const minimumDebtService = totalMinimumDebtService(debts);

  const [netIncome, essentials] = await Promise.all([
    observedNetIncome(window),
    essentialMonthlyBaseline(window, { minimumDebtService: minimumDebtService.total }),
  ]);

  const cashAccounts: CashAccountInput[] = accountRows
    .filter((a) => a.type === "depository")
    .map((a) => {
      const snapshot = balanceByAccount.get(a.accountId);
      return {
        accountId: a.accountId,
        name: a.name,
        institution: a.institution,
        subtype: a.subtype as AccountSubtype | null,
        balance: snapshot?.balance ?? "0.00",
        apy: a.apy,
        maturityDate: a.maturityDate,
        balanceAsOf: snapshot?.date ?? null,
      };
    });

  const cash = classifyCashTiers({
    accounts: cashAccounts,
    essentialMonthly: essentials.baseline,
  });

  return {
    today,
    currency: CURRENCY,
    window,
    historyMonths: earliest[0]?.earliest ? monthsBetween(earliest[0].earliest, today) : 0,
    netIncome,
    essentials,
    cash,
    debts,
    minimumDebtService,
    accounts: accountRows.map((a) => {
      const snapshot = balanceByAccount.get(a.accountId);
      return {
        ...a,
        subtype: a.subtype as AccountSubtype | null,
        taxTreatment: a.taxTreatment as AccountTaxTreatment | null,
        balance: snapshot?.balance ?? null,
        balanceAsOf: snapshot?.date ?? null,
      };
    }),
    contributionRules: ruleRows.map((r) => ({
      ...r,
      taxTreatment: r.taxTreatment as AccountTaxTreatment | null,
      employeeBasis: r.employeeBasis as EmployeeContributionBasis,
      matchBasis: r.matchBasis as EmployerMatchBasis,
    })),
    contributionsYtd: ytdRows.map((r) => ({
      ruleId: r.ruleId,
      accountId: r.accountId,
      taxTreatment: r.taxTreatment as AccountTaxTreatment | null,
      employee: Money.fromString(r.employee ?? "0", CURRENCY).toString(),
      employer: Money.fromString(r.employer ?? "0", CURRENCY).toString(),
      gross: Money.fromString(r.gross ?? "0", CURRENCY).toString(),
      periods: r.periods,
      lastPayDate: r.lastPayDate ?? null,
    })),
    contributionYear,
    household: {
      profile: profileRow[0]
        ? {
            reserveMonthsOverride: profileRow[0].reserveMonthsOverride,
            retirementTargetAge: profileRow[0].retirementTargetAge,
            benchmarkSavingsApy: profileRow[0].benchmarkSavingsApy,
            needsPct: profileRow[0].needsPct,
            wantsPct: profileRow[0].wantsPct,
            savingsPct: profileRow[0].savingsPct,
            highInterestThresholdApr: profileRow[0].highInterestThresholdApr,
            currency: profileRow[0].currency,
          }
        : null,
      members: memberRows,
    },
    budgets: budgetRows,
    categories: categoryRows.map((c) => ({
      ...c,
      kind: c.kind as CategoryKind,
      necessity: c.necessity as CategoryNecessity | null,
    })),
    monthlySpend,
    holdings: holdingsTotals(accountRows, balanceByAccount),
    knownFutureCosts,
  };
}

/**
 * Investable totals bucketed by tax container.
 *
 * Read from the **latest `account_snapshots` row**, not by re-pricing holdings:
 * that is the same path net worth uses, it already accounts for balance-only
 * accounts that hold no itemized positions, and duplicating the pricing logic
 * here would give the advice page a second number that can disagree with the
 * investments page.
 */
function holdingsTotals(
  accountRows: readonly {
    accountId: string;
    type: string;
    taxTreatment: string | null;
  }[],
  balanceByAccount: ReadonlyMap<string, { balance: string }>,
): AdviceHoldingsTotals {
  const buckets = new Map<string, Money>();
  const add = (key: string, amount: Money): void => {
    buckets.set(key, (buckets.get(key) ?? Money.zero(CURRENCY)).add(amount));
  };

  for (const account of accountRows) {
    if (account.type !== "investment" && account.type !== "crypto_ira") continue;
    const balance = balanceByAccount.get(account.accountId)?.balance;
    if (balance === undefined) continue;
    add(account.taxTreatment ?? "unclassified", Money.fromString(balance, CURRENCY));
  }

  const read = (key: string): string => (buckets.get(key) ?? Money.zero(CURRENCY)).toString();
  return {
    total: Money.sum([...buckets.values()], CURRENCY).toString(),
    taxable: read("taxable"),
    taxDeferred: read("tax_deferred"),
    roth: read("roth"),
    hsa: read("hsa"),
    unclassified: read("unclassified"),
  };
}

/** `liabilities` rows for the given accounts (empty list short-circuits). */
async function debtLiabilities(accountIds: readonly string[]) {
  if (accountIds.length === 0) return [];
  return db
    .select({
      accountId: liabilities.accountId,
      principalAtOrigination: liabilities.principalAtOrigination,
      annualRate: liabilities.annualRate,
      termMonths: liabilities.termMonths,
      startDate: liabilities.startDate,
      updatedAt: liabilities.updatedAt,
    })
    .from(liabilities)
    .where(inArray(liabilities.accountId, [...accountIds]));
}

/** `credit_lines` rows for the given accounts (empty list short-circuits). */
async function debtCreditLines(accountIds: readonly string[]) {
  if (accountIds.length === 0) return [];
  return db
    .select({
      accountId: creditLines.accountId,
      apr: creditLines.apr,
      creditLimit: creditLines.creditLimit,
      minimumPayment: creditLines.minimumPayment,
      minimumPaymentPercent: creditLines.minimumPaymentPercent,
      updatedAt: creditLines.updatedAt,
    })
    .from(creditLines)
    .where(inArray(creditLines.accountId, [...accountIds]));
}
