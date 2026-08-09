import type { IncomeCadence } from "@/db/schema/income-sources.ts";
import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";
import { periodsPerYear } from "./schedule.ts";

/**
 * Savings-rate derivation (P14-07, ADR-031 §4).
 *
 * The rate is DERIVED, never stored — there is no `savings_rate` column and
 * there should never be one. Recomputing from the income sources and the
 * materialized contribution ledger means a corrected paycheck or a re-run
 * backfill fixes the number everywhere at once.
 *
 *   annual gross     = Σ over ACTIVE sources of (gross_per_period × periods/yr)
 *   annual employee  = Σ contributions.employee_amount over the caller's window
 *   rate %           = annual employee ÷ annual gross × 100
 *
 * The caller scopes `contributions` — normally a trailing 12 months. A partial
 * window (a rule created mid-year, or a backfill that hasn't run) understates
 * the rate, which is exactly why the dashboard card (P14-17) carries estimate
 * framing rather than presenting this as a measured fact.
 *
 * Only the EMPLOYEE side counts toward the rate: an employer match is not income
 * the user chose to save. It is returned separately because it is still real
 * cost basis and the card shows it.
 */

/** The income-source fields the rate reads — a subset of `IncomeSource`. */
export interface SavingsRateSource {
  readonly cadence: IncomeCadence;
  readonly grossPerPeriod: string;
  readonly currency: string;
  readonly active: boolean;
}

/** The ledger fields the rate reads — a subset of `IncomeContribution`. */
export interface SavingsRateContribution {
  readonly employeeAmount: string;
  readonly employerAmount: string;
  readonly currency: string;
}

export interface SavingsRateResult {
  /** Projected annual gross across active sources. */
  readonly annualGross: Money;
  /** Employee contributions summed over the caller's window. */
  readonly annualEmployee: Money;
  /** Employer match summed over the same window (excluded from the rate). */
  readonly annualEmployer: Money;
  /**
   * Employee ÷ gross as a percentage string with 2 decimals ("8.25"), or null
   * when there is no gross to divide by — an undefined rate, not zero.
   */
  readonly ratePct: string | null;
}

/**
 * Derive the savings rate from income sources and materialized contributions.
 *
 * Inactive sources are excluded from gross: a paused paycheck is not income.
 * Their historical contributions still count, because those dollars were really
 * saved — which can push the rate above 100% in the year a source is retired.
 * That is honest arithmetic on a real edge case, not a bug to clamp away.
 *
 * @param sources - The user's income sources (inactive ones are skipped).
 * @param contributions - Ledger rows already scoped to the display window.
 * @param baseCurrency - Currency for the sums. Default `USD`.
 * @returns Annual gross, employee and employer totals, and the rate.
 * @throws If a source or contribution is in a different currency (cross-currency
 *   totals must go through `fx_rates` first — CLAUDE.md §Money).
 */
export function savingsRate(
  sources: readonly SavingsRateSource[],
  contributions: readonly SavingsRateContribution[],
  baseCurrency = "USD",
): SavingsRateResult {
  let annualGross = Money.zero(baseCurrency);
  for (const source of sources) {
    if (!source.active) continue;
    const perPeriod = Money.fromString(source.grossPerPeriod, source.currency);
    annualGross = annualGross.add(perPeriod.mul(periodsPerYear(source.cadence)));
  }

  let annualEmployee = Money.zero(baseCurrency);
  let annualEmployer = Money.zero(baseCurrency);
  for (const contribution of contributions) {
    annualEmployee = annualEmployee.add(
      Money.fromString(contribution.employeeAmount, contribution.currency),
    );
    annualEmployer = annualEmployer.add(
      Money.fromString(contribution.employerAmount, contribution.currency),
    );
  }

  const ratePct = annualGross.isZero()
    ? null
    : new Decimal(annualEmployee.toString())
        .dividedBy(new Decimal(annualGross.toString()))
        .times(100)
        .toDecimalPlaces(2)
        .toString();

  return { annualGross, annualEmployee, annualEmployer, ratePct };
}
