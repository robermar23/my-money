import { Money } from "@/lib/money/money.ts";

/**
 * Dividend / interest income breakdown (Phase 5, P5-09/P5-23). Aggregates
 * `investment_transactions` of subtype 'dividend' / 'interest' into per-period
 * buckets. Amounts are already in our convention (positive = inflow) after the
 * mapper sign-flip; summed via Money, never raw Number.
 *
 * Period keys are derived by slicing the `YYYY-MM-DD` trade date — no Date
 * parsing, so there is no timezone ambiguity.
 */

/** The investment-transaction fields the income breakdown consumes. */
export interface IncomeTxn {
  readonly subtype: string | null;
  /** Trade date as 'YYYY-MM-DD'. */
  readonly tradeDate: string;
  readonly amount: string;
  readonly isoCurrencyCode: string;
}

export type IncomePeriod = "month" | "quarter" | "year";

export interface IncomePoint {
  /** 'YYYY-MM' | 'YYYY-Qn' | 'YYYY'. */
  readonly period: string;
  readonly dividend: Money;
  readonly interest: Money;
  readonly total: Money;
}

function periodKey(tradeDate: string, period: IncomePeriod): string {
  const year = tradeDate.slice(0, 4);
  if (period === "year") return year;
  const month = Number(tradeDate.slice(5, 7));
  if (period === "quarter") return `${year}-Q${Math.ceil(month / 3)}`;
  return `${year}-${tradeDate.slice(5, 7)}`;
}

/**
 * Sum dividend + interest income by period.
 *
 * @param txns - Investment transactions (non-income rows are ignored).
 * @param period - Grouping granularity.
 * @param currency - Currency to sum in.
 * @returns Per-period income points, sorted by period ascending. Empty when
 *   there is no income.
 */
export function incomeByPeriod(
  txns: readonly IncomeTxn[],
  period: IncomePeriod,
  currency: string,
): IncomePoint[] {
  const dividends = new Map<string, Money>();
  const interest = new Map<string, Money>();

  for (const t of txns) {
    if (t.subtype !== "dividend" && t.subtype !== "interest") continue;
    const key = periodKey(t.tradeDate, period);
    const amount = Money.fromString(t.amount, t.isoCurrencyCode);
    const bucket = t.subtype === "dividend" ? dividends : interest;
    bucket.set(key, (bucket.get(key) ?? Money.zero(currency)).add(amount));
  }

  const keys = [...new Set([...dividends.keys(), ...interest.keys()])].sort();
  return keys.map((key) => {
    const dividend = dividends.get(key) ?? Money.zero(currency);
    const intr = interest.get(key) ?? Money.zero(currency);
    return { period: key, dividend, interest: intr, total: dividend.add(intr) };
  });
}
