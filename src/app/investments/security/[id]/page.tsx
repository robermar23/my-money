import { requireUser } from "@/lib/auth/require-user.ts";
import { valueHolding } from "@/lib/holdings/value.ts";
import { basisProvenance } from "@/lib/investments/basis-provenance.ts";
import { formatQuantity } from "@/lib/investments/format.ts";
import { gainLoss } from "@/lib/investments/gain-loss.ts";
import { incomeByPeriod } from "@/lib/investments/income.ts";
import { lotCoverage, resolveCostBasis } from "@/lib/investments/lots.ts";
import {
  holdingSnapshotSeries,
  securityDetail,
  securityIncome,
  securityPriceHistory,
} from "@/lib/investments/queries.ts";
import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ValueOverTimeChart } from "../../performance/value-over-time-chart.tsx";
import { PriceHistoryChart } from "../price-history-chart.tsx";

interface PageProps {
  readonly params: Promise<{ id: string }>;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Lot provenance labels — `income` is a payroll contribution (P14-16). */
const LOT_SOURCE_LABEL: Record<string, string> = {
  manual: "Manual",
  plaid: "Synced",
  income: "Contribution",
};

/** ISO date `monthsBack` months before today (history window for the charts). */
function isoMonthsAgo(monthsBack: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  return d.toISOString().slice(0, 10);
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  if (!UUID_RE.test(id)) return { title: "Security" };
  const detail = await securityDetail(id);
  const name = detail?.security?.name ?? detail?.holding.symbol ?? "Security";
  return { title: name };
}

export default async function SecurityDetailPage(props: PageProps): Promise<React.JSX.Element> {
  await requireUser();
  const { id } = await props.params;
  if (!UUID_RE.test(id)) notFound();

  const detail = await securityDetail(id);
  if (!detail) notFound();

  const { holding, accountName, accountCurrency } = detail;
  const currency = accountCurrency;
  const today = new Date().toISOString().slice(0, 10);
  const from = isoMonthsAgo(24);

  const [valuation, priceHistory, snapshots, income] = await Promise.all([
    valueHolding(holding, currency, today),
    securityPriceHistory(holding.symbol, { from, to: today }),
    holdingSnapshotSeries(id, { from, to: today }),
    securityIncome(id),
  ]);

  const isCash = holding.assetClass === "cash";
  const costBasis = isCash
    ? null
    : resolveCostBasis({ costBasis: holding.costBasis }, detail.lots, currency);
  const priced = valuation.closeUsed !== null || isCash;
  const gl = priced && costBasis ? gainLoss({ value: valuation.value, costBasis }) : null;

  // Forward dividend yield = forward annual rate ÷ current price (derived at
  // display, never stored — ADR-020). Null unless we have both a rate and price.
  const rate = detail.security?.dividendRate ?? null;
  const close = valuation.closeUsed;
  const forwardYield =
    rate && close && !new Decimal(close).isZero()
      ? new Decimal(rate).dividedBy(new Decimal(close)).times(100).toDecimalPlaces(2).toFixed(2)
      : null;

  const coverage = detail.lots.length > 0 ? lotCoverage(holding, detail.lots) : null;
  // P14-16 — say where the basis came from when a contribution rule funds it.
  const provenance = basisProvenance(detail.lots);

  // Charts (Number() only at this display edge).
  const pricePoints = priceHistory.map((p) => ({ date: p.date, close: Number(p.value) }));
  const valuePoints = snapshots.map((s) => ({
    date: s.date,
    value: Number(s.value),
    costBasis: s.costBasis === null ? null : Number(s.costBasis),
  }));

  // Dividends received (all-time), summed and listed by year.
  const dividendTotal = Money.sum(
    income.map((t) => Money.fromString(t.amount, t.isoCurrencyCode)),
    currency,
  );
  const dividendByYear = incomeByPeriod(
    income.map((t) => ({
      subtype: t.subtype,
      tradeDate: t.tradeDate,
      amount: t.amount,
      isoCurrencyCode: t.isoCurrencyCode,
    })),
    "year",
    currency,
  );

  const meta = detail.security;

  return (
    <main className="mx-auto max-w-4xl p-6">
      <Link href="/investments" className="text-sm text-zinc-500 hover:underline">
        ← Investments
      </Link>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-mono font-semibold text-2xl tracking-tight">{holding.symbol}</h1>
          <p className="mt-1 text-sm text-zinc-500">{meta?.name ?? "Manual holding"}</p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span>{accountName}</span>
            {meta?.assetType && <span>· {meta.assetType}</span>}
            {meta?.sector && <span>· {meta.sector}</span>}
            {meta?.industry && <span>· {meta.industry}</span>}
            {meta?.region && <span>· {meta.region}</span>}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-3xl tabular-nums">
            {priced ? valuation.value.format() : "—"}
          </div>
          <div className="mt-0.5 text-sm text-zinc-500">
            {formatQuantity(holding.quantity)} ×{" "}
            {valuation.closeUsed
              ? Money.fromString(valuation.closeUsed, currency).format()
              : isCash
                ? "face"
                : "—"}
            {gl?.absolute && (
              <span
                className={
                  gl.absolute.isNegative()
                    ? "ml-2 text-red-600 dark:text-red-400"
                    : "ml-2 text-emerald-600 dark:text-emerald-400"
                }
              >
                {gl.absolute.format()} ({gl.percent}%)
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Cost basis" value={costBasis ? costBasis.format() : "—"} />
        <Stat label="Forward yield" value={forwardYield ? `${forwardYield}%` : "—"} />
        <Stat
          label="Forward dividend"
          value={rate ? `${Money.fromString(rate, currency).format()}/sh` : "—"}
        />
        <Stat
          label="Expense ratio"
          value={meta?.expenseRatio ? `${new Decimal(meta.expenseRatio).toFixed(2)}%` : "—"}
        />
      </div>

      {/* P14-16 — a 401k's basis now comes from the user's own contribution
          rule rather than the institution. Say so, and say when the shares
          behind it are a manual entry (ADR-031 §3). */}
      {provenance.fromContributions && (
        <p className="mt-3 text-xs text-zinc-500">
          Cost basis tracked from payroll contributions.{" "}
          <Link href="/settings/income" className="underline">
            Income settings
          </Link>
          {provenance.hasBasisOnlyContributions && (
            <>
              {" "}
              Some contributions could not be priced, so their basis is recorded without shares —
              this position's quantity is your own entry.
            </>
          )}
        </p>
      )}

      <section className="mt-8">
        <h2 className="font-medium">Price history</h2>
        <p className="mt-0.5 text-xs text-zinc-400">Daily close, up to the last 24 months.</p>
        <div className="mt-3">
          <PriceHistoryChart points={pricePoints} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="font-medium">Value & cost basis over time</h2>
        <p className="mt-0.5 text-xs text-zinc-400">
          Gap between value and cost basis is the unrealized gain/loss.
        </p>
        <div className="mt-3">
          {valuePoints.length >= 2 ? (
            <ValueOverTimeChart points={valuePoints} currency={currency} />
          ) : (
            <p className="rounded-md border border-zinc-200 border-dashed p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
              Not enough snapshot history for this position yet.
            </p>
          )}
        </div>
      </section>

      {detail.lots.length > 0 && (
        <section className="mt-8">
          <h2 className="font-medium">Cost-basis lots</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500 uppercase">
                <tr>
                  <th className="py-2 pr-2 text-right">Quantity</th>
                  <th className="py-2 text-right">Cost basis</th>
                  <th className="py-2 pl-4">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {detail.lots.map((lot, i) => (
                  <tr key={`${lot.quantity}-${lot.costBasisTotal}-${i}`}>
                    <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                      {formatQuantity(lot.quantity)}
                    </td>
                    <td className="py-1.5 text-right font-mono tabular-nums">
                      {Money.fromString(lot.costBasisTotal, currency).format()}
                    </td>
                    <td className="py-1.5 pl-4 text-zinc-500">
                      {LOT_SOURCE_LABEL[lot.source] ?? lot.source}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {coverage && !coverage.isComplete && (
            <p className="mt-2 text-xs text-zinc-500">
              Lots cover {formatQuantity(coverage.coveredQty)} of{" "}
              {formatQuantity(coverage.holdingQty)} shares.
            </p>
          )}
        </section>
      )}

      <section className="mt-8">
        <h2 className="font-medium">Dividends received</h2>
        {income.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No dividend or interest income recorded.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full max-w-sm text-sm">
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {dividendByYear.map((pt) => (
                  <tr key={pt.period}>
                    <td className="py-1.5 pr-2">{pt.period}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">
                      {pt.total.format()}
                    </td>
                  </tr>
                ))}
                <tr className="font-medium">
                  <td className="py-1.5 pr-2">Total</td>
                  <td className="py-1.5 text-right font-mono tabular-nums">
                    {dividendTotal.format()}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mt-8 text-xs text-zinc-400">
        Gain/loss and yield are display metrics, not tax or investment advice — no realized
        gain/loss, tax lots, or 1099 reporting. Pre-deploy history estimates today's quantity
        against past prices.
      </p>
    </main>
  );
}

function Stat({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 font-mono font-semibold text-lg tabular-nums">{value}</div>
    </div>
  );
}
