import { db } from "@/db/client.ts";
import type { IncomeCadence } from "@/db/schema/income-sources.ts";
import {
  accounts,
  holdingLots,
  holdings,
  incomeContributions,
  incomeSources,
  retirementContributions,
} from "@/db/schema/index.ts";
import type { EmployeeContributionBasis, EmployerMatchBasis } from "@/db/schema/index.ts";
import { asc, count, desc, eq, max, sum } from "drizzle-orm";

/**
 * Read models for the income-management surface (P14-14).
 *
 * These are pure reads — nothing here writes, and nothing here computes money.
 * Dollar figures come back as `numeric` strings and are handed to `Money` at
 * the point of display (CLAUDE.md §Money).
 *
 * Kept out of the page component because Batch 5 needs the same shapes: the
 * dashboard savings-rate card (P14-17) and the per-account contribution ledger
 * (P14-18) both read income sources and materialized contributions.
 */

/** An income source plus its (at most one, in this UI) contribution rule. */
export interface IncomeSourceRow {
  readonly id: string;
  readonly name: string;
  readonly cadence: IncomeCadence;
  readonly grossPerPeriod: string;
  readonly currency: string;
  readonly anchorDate: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly active: boolean;
  readonly notes: string | null;
  readonly rule: ContributionRuleRow | null;
}

/** A contribution rule, joined to the names it points at. */
export interface ContributionRuleRow {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly holdingId: string | null;
  readonly holdingSymbol: string | null;
  readonly employeeBasis: EmployeeContributionBasis;
  readonly employeeValue: string;
  readonly pretax: boolean;
  readonly matchBasis: EmployerMatchBasis;
  readonly matchValue: string;
  readonly matchCapPercent: string | null;
  readonly active: boolean;
  /** How many pay dates the job has already materialized for this rule. */
  readonly materializedCount: number;
  /** The most recent materialized pay date, or null before the first run. */
  readonly lastPayDate: string | null;
  /** Employee dollars materialized to date — the audit total. */
  readonly totalEmployee: string;
  /** Employer dollars materialized to date. */
  readonly totalEmployer: string;
}

/** An investment account the rule may fund. */
export interface InvestmentAccountOption {
  readonly id: string;
  readonly name: string;
  readonly institution: string;
  readonly currency: string;
}

/** A position inside one of those accounts. */
export interface HoldingOption {
  readonly id: string;
  readonly accountId: string;
  readonly symbol: string;
  /**
   * True when this holding already carries `source='plaid'` cost-basis lots.
   * Targeting it with an income rule risks DOUBLE-COUNTING basis (ADR-031 §5):
   * the sync and the contribution rule would each add the same dollars. The UI
   * warns; it does not refuse (a hard guard is a recorded Open Item).
   */
  readonly hasPlaidLots: boolean;
}

export interface IncomeSettings {
  readonly sources: readonly IncomeSourceRow[];
  readonly investmentAccounts: readonly InvestmentAccountOption[];
  readonly holdings: readonly HoldingOption[];
}

/**
 * Load everything the `/settings/income` page renders in one pass.
 *
 * @returns Sources (each with its rule and materialization tallies), the
 *   investment accounts a rule may fund, and their holdings flagged for the
 *   Plaid double-count warning.
 */
export async function loadIncomeSettings(): Promise<IncomeSettings> {
  const [sourceRows, ruleRows, tallies, accountRows, holdingRows, plaidLotHoldingIds] =
    await Promise.all([
      db
        .select()
        .from(incomeSources)
        .orderBy(desc(incomeSources.active), asc(incomeSources.startDate), asc(incomeSources.name)),
      db
        .select({
          id: retirementContributions.id,
          incomeSourceId: retirementContributions.incomeSourceId,
          accountId: retirementContributions.accountId,
          accountName: accounts.name,
          holdingId: retirementContributions.holdingId,
          holdingSymbol: holdings.symbol,
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
        .leftJoin(holdings, eq(holdings.id, retirementContributions.holdingId))
        .orderBy(asc(retirementContributions.createdAt)),
      db
        .select({
          ruleId: incomeContributions.retirementContributionId,
          materialized: count(),
          lastPayDate: max(incomeContributions.payDate),
          totalEmployee: sum(incomeContributions.employeeAmount),
          totalEmployer: sum(incomeContributions.employerAmount),
        })
        .from(incomeContributions)
        .groupBy(incomeContributions.retirementContributionId),
      db
        .select({
          id: accounts.id,
          name: accounts.name,
          institution: accounts.institution,
          currency: accounts.currency,
        })
        .from(accounts)
        .where(eq(accounts.type, "investment"))
        .orderBy(asc(accounts.name)),
      db
        .select({ id: holdings.id, accountId: holdings.accountId, symbol: holdings.symbol })
        .from(holdings)
        .innerJoin(accounts, eq(accounts.id, holdings.accountId))
        .where(eq(accounts.type, "investment"))
        .orderBy(asc(holdings.symbol)),
      db
        .selectDistinct({ holdingId: holdingLots.holdingId })
        .from(holdingLots)
        .where(eq(holdingLots.source, "plaid")),
    ]);

  const plaidHoldings = new Set(plaidLotHoldingIds.map((row) => row.holdingId));
  const talliesByRule = new Map(tallies.map((row) => [row.ruleId, row]));

  const rulesBySource = new Map<string, ContributionRuleRow>();
  for (const rule of ruleRows) {
    // The Phase-14 UI presents one rule per source; the schema deliberately
    // allows more (a pre-tax/Roth split later). Keep the earliest so the page
    // stays deterministic if a second rule ever arrives from elsewhere.
    if (rulesBySource.has(rule.incomeSourceId)) continue;
    const tally = talliesByRule.get(rule.id);
    rulesBySource.set(rule.incomeSourceId, {
      id: rule.id,
      accountId: rule.accountId,
      accountName: rule.accountName,
      holdingId: rule.holdingId,
      holdingSymbol: rule.holdingSymbol,
      employeeBasis: rule.employeeBasis as EmployeeContributionBasis,
      employeeValue: rule.employeeValue,
      pretax: rule.pretax,
      matchBasis: rule.matchBasis as EmployerMatchBasis,
      matchValue: rule.matchValue,
      matchCapPercent: rule.matchCapPercent,
      active: rule.active,
      materializedCount: tally?.materialized ?? 0,
      lastPayDate: tally?.lastPayDate ?? null,
      totalEmployee: tally?.totalEmployee ?? "0",
      totalEmployer: tally?.totalEmployer ?? "0",
    });
  }

  return {
    sources: sourceRows.map((source) => ({
      id: source.id,
      name: source.name,
      cadence: source.cadence as IncomeCadence,
      grossPerPeriod: source.grossPerPeriod,
      currency: source.currency,
      anchorDate: source.anchorDate,
      startDate: source.startDate,
      endDate: source.endDate,
      active: source.active,
      notes: source.notes,
      rule: rulesBySource.get(source.id) ?? null,
    })),
    investmentAccounts: accountRows,
    holdings: holdingRows.map((holding) => ({
      ...holding,
      hasPlaidLots: plaidHoldings.has(holding.id),
    })),
  };
}

/**
 * Count the contributions already materialized for a rule (or for every rule on
 * a source). Guards the destructive actions: deleting a rule or a source
 * cascades its `income_contributions`, which is the audit trail behind real cost
 * basis on the 401k. We refuse rather than silently orphan lots (CLAUDE.md
 * §Database — historical financial data is the entire product).
 *
 * @param scope - Either a rule id or a source id to count across.
 * @returns The number of materialized contribution rows.
 */
export async function countMaterializedContributions(
  scope: { readonly ruleId: string } | { readonly sourceId: string },
): Promise<number> {
  if ("ruleId" in scope) {
    const [row] = await db
      .select({ total: count() })
      .from(incomeContributions)
      .where(eq(incomeContributions.retirementContributionId, scope.ruleId));
    return row?.total ?? 0;
  }
  const [row] = await db
    .select({ total: count() })
    .from(incomeContributions)
    .innerJoin(
      retirementContributions,
      eq(retirementContributions.id, incomeContributions.retirementContributionId),
    )
    .where(eq(retirementContributions.incomeSourceId, scope.sourceId));
  return row?.total ?? 0;
}
