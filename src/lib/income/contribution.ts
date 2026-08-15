import type {
  EmployeeContributionBasis,
  EmployerMatchBasis,
} from "@/db/schema/retirement-contributions.ts";
import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";

/**
 * Per-period contribution + employer-match math (P14-06, ADR-030/031).
 *
 * Pure and Decimal-only. Every value here becomes cost basis on a 401k holding,
 * so a float percentage would quietly corrupt gain/loss forever — CLAUDE.md
 * §Money: no native arithmetic on money, ever.
 *
 * Scope reminders (FEATURE.md 2026-08-09): this computes GROSS-side contribution
 * dollars only. There is no withholding, no FICA, no net pay, and `pretax` is a
 * label that drives none of this math. The employer match is single-tier plus an
 * optional cap; a tiered formula engine is a recorded Open Item.
 */

/** The rule fields the math reads — a structural subset of `RetirementContribution`. */
export interface ContributionRuleInput {
  readonly employeeBasis: EmployeeContributionBasis;
  /** A percentage when the basis is `percent`, else dollars per period. */
  readonly employeeValue: string;
  readonly matchBasis: EmployerMatchBasis;
  /** A percentage or dollars per period, per `matchBasis`. Ignored when `none`. */
  readonly matchValue: string;
  /** Employer-match ceiling as a percent of gross; null = uncapped. */
  readonly matchCapPercent: string | null;
}

export interface ComputedContribution {
  /** The employee's own contribution — the savings-rate numerator. */
  readonly employee: Money;
  /** The employer match. Cost basis too, but never part of the savings rate. */
  readonly employer: Money;
  /** employee + employer — the dollars the materialization job invests. */
  readonly total: Money;
}

/** Assert a rule value is a non-negative decimal string, then hand back its Decimal. */
function nonNegative(value: string, label: string): Decimal {
  let decimal: Decimal;
  try {
    decimal = new Decimal(value);
  } catch {
    throw new Error(`${label} is not a valid decimal: ${value}`);
  }
  if (decimal.isNegative()) {
    throw new Error(`${label} must be non-negative, got: ${value}`);
  }
  return decimal;
}

/** `base × pct / 100`, rounded to cents (Money.div rounds half-even). */
function percentOf(base: Money, pct: Decimal): Money {
  return base.mul(pct.toString()).div(100);
}

/** Round a Money to cents without leaving the Money type. */
function toCents(value: Money): Money {
  return Money.fromString(value.toString(), value.currency);
}

/** The lesser of two same-currency Money values. */
function min(a: Money, b: Money): Money {
  return a.sub(b).isNegative() ? a : b;
}

/**
 * Compute one pay period's employee contribution and employer match.
 *
 * Employee: a percent of gross, or a fixed dollar amount. A fixed amount larger
 * than gross is CLAMPED to gross — a misconfigured rule must not manufacture
 * cost basis from income that does not exist. The clamp surfaces in the
 * create/edit preview (P14-15) so the user sees the correction rather than
 * discovering it months later in their gain/loss.
 *
 * Employer: `none` | `percent_of_gross` | `percent_of_contribution` | `amount`,
 * then clamped to `matchCapPercent × gross` when a cap is set.
 *
 * @param rule - The contribution rule's math fields.
 * @param gross - Gross pay for the period; carries the result currency.
 * @returns The employee, employer, and total amounts, each rounded to cents.
 * @throws If gross or any rule value is negative, or a basis is unrecognised.
 */
export function computeContribution(
  rule: ContributionRuleInput,
  gross: Money,
): ComputedContribution {
  if (gross.isNegative()) {
    throw new Error("Gross pay must be non-negative");
  }
  const grossCents = toCents(gross);
  const employeeValue = nonNegative(rule.employeeValue, "employeeValue");
  const matchValue = nonNegative(rule.matchValue, "matchValue");

  let employee: Money;
  switch (rule.employeeBasis) {
    case "percent":
      employee = percentOf(grossCents, employeeValue);
      break;
    case "amount":
      employee = min(Money.fromString(employeeValue.toFixed(2), gross.currency), grossCents);
      break;
    default:
      throw new Error(`Unknown employee contribution basis: ${rule.employeeBasis}`);
  }

  let employer: Money;
  switch (rule.matchBasis) {
    case "none":
      employer = Money.zero(gross.currency);
      break;
    case "percent_of_gross":
      employer = percentOf(grossCents, matchValue);
      break;
    case "percent_of_contribution":
      employer = percentOf(employee, matchValue);
      break;
    case "amount":
      employer = Money.fromString(matchValue.toFixed(2), gross.currency);
      break;
    default:
      throw new Error(`Unknown employer match basis: ${rule.matchBasis}`);
  }

  if (rule.matchCapPercent !== null) {
    const cap = nonNegative(rule.matchCapPercent, "matchCapPercent");
    employer = min(employer, percentOf(grossCents, cap));
  }

  return { employee, employer, total: employee.add(employer) };
}
