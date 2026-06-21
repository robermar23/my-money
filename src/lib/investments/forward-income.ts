import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";
import { type IncomeTxn, incomeByPeriod } from "./income.ts";

/**
 * Forward-looking income math (PLAN9 Batch 5, ADR-022). Pure, I/O-free, and
 * `Money`/`Decimal`-based (CLAUDE.md §Money & Numeric Precision).
 *
 * Two surfaces:
 *   - {@link forwardIncome}: the *projected* forward 12-month dividend/interest —
 *     held quantity × the security's forward annual rate (ADR-020), with a
 *     per-holding/per-account breakdown and a yield-on-cost figure. This is
 *     data-grounded (shares × published rate), not a speculative forecast.
 *   - {@link incomeGrowth}: the *actual* received income over time — YoY growth
 *     and a trailing-12-month run rate. A real "is my income growing?" line, not
 *     a projection.
 *
 * Neither is tax or investment advice (CLAUDE.md §Domain Scope) — forward income
 * is an estimate of distributions, never a recommendation.
 */

/** One held position's inputs to the forward-income projection. */
export interface ForwardHolding {
  readonly holdingId: string;
  readonly symbol: string;
  readonly accountId: string;
  readonly accountName: string;
  /** Share / coin quantity held. */
  readonly quantity: string;
  /** Forward annual dividend/distribution rate ($/share); null when none known. */
  readonly dividendRate: string | null;
  /** Resolved cost basis; null when unknown (cash, manual, no lots). */
  readonly costBasis: string | null;
}

export interface ForwardIncomeRow {
  readonly holdingId: string;
  readonly symbol: string;
  readonly accountId: string;
  readonly accountName: string;
  /** Projected forward 12-month income (quantity × rate). */
  readonly annualIncome: Money;
  /** annualIncome ÷ costBasis × 100, 2dp; null when basis is unknown or zero. */
  readonly yieldOnCost: string | null;
}

export interface ForwardAccountIncome {
  readonly accountId: string;
  readonly accountName: string;
  readonly annualIncome: Money;
}

export interface ForwardIncome {
  /** Total projected forward 12-month income across all holdings. */
  readonly total: Money;
  /** Portfolio yield-on-cost over income-producing holdings with known basis. */
  readonly yieldOnCost: string | null;
  /** Income-producing holdings only, largest first. */
  readonly rows: ForwardIncomeRow[];
  /** Income-producing accounts only, largest first. */
  readonly byAccount: ForwardAccountIncome[];
}

/** Descending Money comparator (largest first). */
function byValueDesc(a: Money, b: Money): number {
  return new Decimal(b.toString()).comparedTo(new Decimal(a.toString()));
}

/**
 * Projected forward 12-month dividend/interest income.
 *
 * Each holding's income is `quantity × dividend_rate` (the forward annual rate
 * from ADR-020). A null/blank rate contributes exactly zero — never NaN. The
 * yield-on-cost denominator only includes income-producing holdings whose cost
 * basis is known, so an unknown-basis position never inflates the figure.
 *
 * @param holdings - Held positions with their forward rate and resolved basis.
 * @param currency - Currency to total in (single-currency app; default caller USD).
 * @returns Total, portfolio yield-on-cost, and per-holding / per-account rows.
 */
export function forwardIncome(
  holdings: readonly ForwardHolding[],
  currency: string,
): ForwardIncome {
  const rows: ForwardIncomeRow[] = [];
  const accountTotals = new Map<string, { name: string; total: Money }>();
  let knownIncome = Money.zero(currency);
  let knownBasis = Money.zero(currency);
  let hasKnownBasis = false;

  for (const h of holdings) {
    const rate = h.dividendRate?.trim();
    const annualIncome =
      rate && rate !== "" ? Money.fromString(rate, currency).mul(h.quantity) : Money.zero(currency);

    let yieldOnCost: string | null = null;
    if (!annualIncome.isZero() && h.costBasis !== null) {
      const basis = new Decimal(h.costBasis);
      if (!basis.isZero()) {
        yieldOnCost = new Decimal(annualIncome.toString())
          .dividedBy(basis)
          .times(100)
          .toDecimalPlaces(2)
          .toFixed(2);
        knownIncome = knownIncome.add(annualIncome);
        knownBasis = knownBasis.add(Money.fromString(h.costBasis, currency));
        hasKnownBasis = true;
      }
    }

    if (!annualIncome.isZero()) {
      rows.push({
        holdingId: h.holdingId,
        symbol: h.symbol,
        accountId: h.accountId,
        accountName: h.accountName,
        annualIncome,
        yieldOnCost,
      });
      const acc = accountTotals.get(h.accountId) ?? {
        name: h.accountName,
        total: Money.zero(currency),
      };
      acc.total = acc.total.add(annualIncome);
      accountTotals.set(h.accountId, acc);
    }
  }

  const total = Money.sum(
    rows.map((r) => r.annualIncome),
    currency,
  );
  const yieldOnCost =
    hasKnownBasis && !knownBasis.isZero()
      ? new Decimal(knownIncome.toString())
          .dividedBy(new Decimal(knownBasis.toString()))
          .times(100)
          .toDecimalPlaces(2)
          .toFixed(2)
      : null;

  rows.sort((a, b) => byValueDesc(a.annualIncome, b.annualIncome));
  const byAccount = [...accountTotals.entries()]
    .map(([accountId, v]) => ({ accountId, accountName: v.name, annualIncome: v.total }))
    .sort((a, b) => byValueDesc(a.annualIncome, b.annualIncome));

  return { total, yieldOnCost, rows, byAccount };
}

export interface IncomeGrowthPoint {
  /** Calendar year, 'YYYY'. */
  readonly year: string;
  readonly total: Money;
  /** Growth vs the prior calendar year, 2dp %; null with no prior-year baseline. */
  readonly yoyPercent: string | null;
}

export interface IncomeGrowth {
  /** Yearly received income, ascending, with year-over-year growth. */
  readonly points: IncomeGrowthPoint[];
  /** Trailing-12-month received income — the current annual run rate. */
  readonly runRate: Money;
  /** YoY growth for the most recent year, or null. */
  readonly latestYoyPercent: string | null;
}

/** ISO date one year before `iso` (UTC; date arithmetic, never money). */
function minusOneYear(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/** Sum dividend/interest income over the trailing 12 months from the latest date. */
function trailingTwelveMonths(txns: readonly IncomeTxn[], currency: string): Money {
  let latest = "";
  for (const t of txns) {
    if ((t.subtype === "dividend" || t.subtype === "interest") && t.tradeDate > latest) {
      latest = t.tradeDate;
    }
  }
  if (latest === "") return Money.zero(currency);
  const start = minusOneYear(latest); // exclusive lower bound
  let total = Money.zero(currency);
  for (const t of txns) {
    if (t.subtype !== "dividend" && t.subtype !== "interest") continue;
    if (t.tradeDate > start && t.tradeDate <= latest) {
      total = total.add(Money.fromString(t.amount, t.isoCurrencyCode));
    }
  }
  return total;
}

/**
 * Actual received-income growth: a yearly series with year-over-year growth and
 * a trailing-12-month run rate. Operates on the same dividend/interest stream as
 * {@link import('./income.ts').incomeByPeriod} — this is history, not a forecast.
 *
 * @param txns - Investment transactions (non-income rows ignored).
 * @param currency - Currency to total in.
 * @returns Yearly points (ascending) + the current annual run rate.
 */
export function incomeGrowth(txns: readonly IncomeTxn[], currency: string): IncomeGrowth {
  const yearly = incomeByPeriod(txns, "year", currency);
  const byYear = new Map(yearly.map((p) => [p.period, p.total]));
  const points: IncomeGrowthPoint[] = yearly.map((p) => {
    const prev = byYear.get(String(Number(p.period) - 1));
    let yoyPercent: string | null = null;
    if (prev && !prev.isZero()) {
      yoyPercent = new Decimal(p.total.toString())
        .minus(new Decimal(prev.toString()))
        .dividedBy(new Decimal(prev.toString()))
        .times(100)
        .toDecimalPlaces(2)
        .toFixed(2);
    }
    return { year: p.period, total: p.total, yoyPercent };
  });

  return {
    points,
    runRate: trailingTwelveMonths(txns, currency),
    latestYoyPercent: points.at(-1)?.yoyPercent ?? null,
  };
}
