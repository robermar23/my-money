import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";

/**
 * Standard fixed-rate amortization math.
 *
 * Convention: `annualRate` is a decimal fraction (0.06 for 6% APR). `termMonths`
 * is the total amortization term. All computations are done with Decimal for
 * exactness, then collapsed to cents at the boundary.
 *
 * For zero-interest loans, we degenerate to linear pay-down (principal / term)
 * to avoid divide-by-zero in the standard formula.
 */

function toDecimal(rate: string | number): Decimal {
  const d = new Decimal(rate);
  if (d.isNegative()) {
    throw new Error(`Interest rate must be non-negative: got ${rate}`);
  }
  return d;
}

function validate(principal: Money, annualRate: string | number, termMonths: number): void {
  if (principal.isNegative()) {
    throw new Error("Principal must be non-negative");
  }
  if (!Number.isInteger(termMonths) || termMonths <= 0) {
    throw new Error(`termMonths must be a positive integer, got ${termMonths}`);
  }
  toDecimal(annualRate);
}

/**
 * Monthly P+I payment for a fixed-rate mortgage.
 *
 * Formula: M = P * r * (1+r)^n / ((1+r)^n - 1)
 * where r = monthly rate (annual / 12), n = term in months.
 *
 * @param principal - Loan principal at origination
 * @param annualRate - Annual interest rate as a decimal (e.g. "0.06" for 6%)
 * @param termMonths - Total loan term in months (e.g. 360 for 30-year)
 * @returns Monthly payment rounded to cents
 */
export function monthlyPayment(
  principal: Money,
  annualRate: string | number,
  termMonths: number,
): Money {
  validate(principal, annualRate, termMonths);

  const annual = toDecimal(annualRate);

  if (annual.isZero()) {
    return principal.div(termMonths);
  }

  const r = annual.dividedBy(12);
  const onePlusR = new Decimal(1).plus(r);
  const onePlusRn = onePlusR.pow(termMonths);
  const numerator = r.times(onePlusRn);
  const denominator = onePlusRn.minus(1);
  const factor = numerator.dividedBy(denominator);

  return principal.mul(factor.toString());
}

/**
 * Remaining principal after `monthsElapsed` of scheduled payments.
 *
 * Computed via the closed-form remaining-balance formula so we don't need to
 * iterate month-by-month. Past the term, returns zero (the loan is paid off).
 *
 * For zero-interest loans, returns max(0, principal - monthlyPayment * monthsElapsed).
 *
 * @param principal - Loan principal at origination
 * @param annualRate - Annual interest rate as a decimal
 * @param termMonths - Total loan term in months
 * @param monthsElapsed - Months of scheduled payments already made (0..termMonths+)
 * @returns Remaining principal, clamped at zero
 */
export function balanceAtMonth(
  principal: Money,
  annualRate: string | number,
  termMonths: number,
  monthsElapsed: number,
): Money {
  validate(principal, annualRate, termMonths);
  if (!Number.isInteger(monthsElapsed) || monthsElapsed < 0) {
    throw new Error(`monthsElapsed must be a non-negative integer, got ${monthsElapsed}`);
  }

  if (monthsElapsed === 0) return principal;
  if (monthsElapsed >= termMonths) return Money.zero(principal.currency);

  const annual = toDecimal(annualRate);

  if (annual.isZero()) {
    const monthly = principal.div(termMonths);
    const paid = monthly.mul(monthsElapsed);
    const remaining = principal.sub(paid);
    return remaining.isNegative() ? Money.zero(principal.currency) : remaining;
  }

  // Closed-form: B_k = P * ((1+r)^n - (1+r)^k) / ((1+r)^n - 1)
  const r = annual.dividedBy(12);
  const onePlusR = new Decimal(1).plus(r);
  const onePlusRn = onePlusR.pow(termMonths);
  const onePlusRk = onePlusR.pow(monthsElapsed);
  const factor = onePlusRn.minus(onePlusRk).dividedBy(onePlusRn.minus(1));

  return principal.mul(factor.toString());
}
