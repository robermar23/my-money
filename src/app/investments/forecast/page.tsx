import { requireUser } from "@/lib/auth/require-user.ts";
import { valueHolding } from "@/lib/holdings/value.ts";
import {
  type ForwardHolding,
  forwardIncome,
  incomeGrowth,
} from "@/lib/investments/forward-income.ts";
import { resolveCostBasis } from "@/lib/investments/lots.ts";
import { goalDate, projectValue } from "@/lib/investments/projection.ts";
import {
  listBalanceOnlyInvestmentAccounts,
  listInvestmentIncome,
  listInvestmentLots,
  listInvestmentPositions,
} from "@/lib/investments/queries.ts";
import { Money } from "@/lib/money/money.ts";
import type { Metadata } from "next";
import Link from "next/link";
import { IncomeGrowthChart } from "./income-growth-chart.tsx";
import { ValueProjectionChart } from "./value-projection-chart.tsx";

export const metadata: Metadata = { title: "Investment forecast" };

const CURRENCY = "USD";
const PROJECTION_YEARS = 30;

/** Growth-assumption presets (URL `rate` param), as annual percent. */
const RATES = [5, 7, 10] as const;
type Rate = (typeof RATES)[number];

function parseRate(raw: string | undefined): Rate {
  const n = Number(raw);
  return (RATES as readonly number[]).includes(n) ? (n as Rate) : 7;
}

/** Validate a positive money-ish input; returns a clean numeric string or null. */
function parseAmount(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,$\s]/g, "");
  return /^\d+(\.\d+)?$/.test(cleaned) ? cleaned : null;
}

interface PageProps {
  readonly searchParams?: Promise<{
    rate?: string;
    goal?: string;
    contrib?: string;
  }>;
}

export default async function ForecastPage(props: PageProps): Promise<React.JSX.Element> {
  await requireUser();
  const search = (await props.searchParams) ?? {};
  const rate = parseRate(search.rate);
  const goalTarget = parseAmount(search.goal);
  const monthlyContribution = parseAmount(search.contrib) ?? "0";
  const today = new Date().toISOString().slice(0, 10);

  const [positions, lots, incomeTxns, balanceOnly] = await Promise.all([
    listInvestmentPositions(),
    listInvestmentLots(),
    listInvestmentIncome(),
    listBalanceOnlyInvestmentAccounts(),
  ]);

  const lotsByHolding = new Map<string, { quantity: string; costBasisTotal: string }[]>();
  for (const lot of lots) {
    const arr = lotsByHolding.get(lot.holdingId) ?? [];
    arr.push({ quantity: lot.quantity, costBasisTotal: lot.costBasisTotal });
    lotsByHolding.set(lot.holdingId, arr);
  }

  // Value each position (for the current portfolio total) and resolve its basis
  // (for yield-on-cost). Cash positions are basis-free (mirrors the overview).
  const rows = await Promise.all(
    positions.map(async (p) => {
      const currency = p.accountCurrency;
      const valuation = await valueHolding(p.holding, currency, today);
      const isCash = p.holding.assetClass === "cash";
      const costBasis = isCash
        ? null
        : resolveCostBasis(
            { costBasis: p.holding.costBasis },
            lotsByHolding.get(p.holding.id) ?? [],
            currency,
          );
      return { p, value: valuation.value, costBasis };
    }),
  );

  // Current portfolio value: priced holdings + balance-only investment accounts.
  const portfolioValue = Money.sum(
    rows.map((r) => r.value),
    CURRENCY,
  );
  const balanceOnlyInBase = balanceOnly.filter((a) => a.currency === CURRENCY);
  const balanceOnlyTotal = Money.sum(
    balanceOnlyInBase.map((a) => Money.fromString(a.balance, CURRENCY)),
    CURRENCY,
  );
  const totalValue = portfolioValue.add(balanceOnlyTotal);

  // Forward 12-month income (shares × forward rate) + yield-on-cost.
  const forwardHoldings: ForwardHolding[] = rows.map((r) => ({
    holdingId: r.p.holding.id,
    symbol: r.p.holding.symbol,
    accountId: r.p.accountId,
    accountName: r.p.accountName,
    quantity: r.p.holding.quantity,
    dividendRate: r.p.dividendRate,
    costBasis: r.costBasis ? r.costBasis.toString() : null,
  }));
  const fwd = forwardIncome(forwardHoldings, CURRENCY);

  // Received-income growth (actuals).
  const growth = incomeGrowth(incomeTxns, CURRENCY);
  const growthPoints = growth.points.map((pt) => ({
    year: pt.year,
    income: Number(pt.total.toString()),
  }));

  // Value projection (illustrative, dashed) + optional goal marker.
  const projection = projectValue(totalValue.toString(), rate, PROJECTION_YEARS);
  const projectionPoints = projection.map((pt) => ({
    year: pt.year,
    value: Number(pt.value),
  }));
  const goal = goalTarget
    ? goalDate(totalValue.toString(), monthlyContribution, rate, goalTarget, today)
    : null;
  const goalReached = goalTarget && !goal ? "not within 100 years" : null;

  const hrefFor = (params: Record<string, string | undefined>): string => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
    const qs = sp.toString();
    return `/investments/forecast${qs ? `?${qs}` : ""}`;
  };

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="font-semibold text-2xl tracking-tight">Investment forecast</h1>

      {/* Mandatory estimate-not-advice banner (ADR-022). Unconditional. */}
      <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 text-sm dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        Projections are illustrative estimates, not financial advice. Forward income assumes today's
        holdings keep their current distribution rate; the value projection compounds a single
        growth assumption and does not predict the market.
      </p>

      {/* Forward income summary */}
      <section className="mt-8">
        <h2 className="font-medium">Projected forward 12-month income</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Forward income" value={fwd.total.format()} />
          <Tile label="Yield on cost" value={fwd.yieldOnCost ? `${fwd.yieldOnCost}%` : "—"} />
          <Tile label="Trailing 12-mo income" value={growth.runRate.format()} />
          <Tile
            label="Income YoY"
            value={growth.latestYoyPercent ? `${growth.latestYoyPercent}%` : "—"}
          />
        </div>

        {fwd.rows.length === 0 ? (
          <p className="mt-4 rounded-md border border-zinc-200 border-dashed p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
            No forward dividend data yet. The weekly enrichment job fills in each security's forward
            rate; holdings with no distribution contribute nothing here.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full max-w-2xl text-sm">
              <thead className="text-left text-xs text-zinc-500 uppercase">
                <tr>
                  <th className="py-2 pr-2">Symbol</th>
                  <th className="py-2 pr-2">Account</th>
                  <th className="py-2 pr-2 text-right">Forward income</th>
                  <th className="py-2 text-right">Yield on cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {fwd.rows.map((row) => (
                  <tr key={row.holdingId}>
                    <td className="py-1.5 pr-2 font-mono">
                      <Link
                        href={`/investments/security/${row.holdingId}`}
                        className="hover:underline"
                      >
                        {row.symbol}
                      </Link>
                    </td>
                    <td className="truncate py-1.5 pr-2 text-zinc-600 dark:text-zinc-400">
                      {row.accountName}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                      {row.annualIncome.format()}
                    </td>
                    <td className="py-1.5 text-right font-mono tabular-nums">
                      {row.yieldOnCost ? `${row.yieldOnCost}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Income growth */}
      <section className="mt-10">
        <h2 className="font-medium">Income growth</h2>
        <p className="mt-0.5 text-xs text-zinc-400">
          Actual dividend &amp; interest received per year — is your income growing?
        </p>
        <div className="mt-3">
          <IncomeGrowthChart points={growthPoints} currency={CURRENCY} />
        </div>
      </section>

      {/* Value projection */}
      <section className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Value projection</h2>
          <div className="flex gap-1 text-sm">
            {RATES.map((r) => (
              <Link
                key={r}
                href={hrefFor({ rate: String(r), goal: search.goal, contrib: search.contrib })}
                className={`rounded-md px-2 py-1 ${
                  r === rate
                    ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {r}%
              </Link>
            ))}
          </div>
        </div>
        <p className="mt-0.5 text-xs text-zinc-400">
          {totalValue.format()} compounding at {rate}% per year over {PROJECTION_YEARS} years
          (dashed — illustrative).
        </p>
        <div className="mt-3">
          <ValueProjectionChart
            points={projectionPoints}
            currency={CURRENCY}
            target={goalTarget ? Number(goalTarget) : null}
            goalLabel={goal ? goal.date : goalReached}
          />
        </div>

        {/* Goal marker control (plain GET form — no client JS). */}
        <form method="GET" className="mt-4 flex flex-wrap items-end gap-3 text-sm">
          <input type="hidden" name="rate" value={String(rate)} />
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Goal target</span>
            <input
              name="goal"
              inputMode="decimal"
              defaultValue={search.goal ?? ""}
              placeholder="1000000"
              className="w-36 rounded-md border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Monthly contribution</span>
            <input
              name="contrib"
              inputMode="decimal"
              defaultValue={search.contrib ?? ""}
              placeholder="0"
              className="w-36 rounded-md border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
            />
          </label>
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-white dark:bg-zinc-50 dark:text-zinc-900"
          >
            Project goal
          </button>
        </form>

        {goalTarget && (
          <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
            {goal ? (
              <>
                At {rate}% with {Money.fromString(monthlyContribution, CURRENCY).format()}/mo, you
                reach {Money.fromString(goalTarget, CURRENCY).format()} around{" "}
                <span className="font-medium">{goal.date}</span>{" "}
                {goal.months > 0 && (
                  <span className="text-zinc-500">(~{(goal.months / 12).toFixed(1)} years).</span>
                )}
              </>
            ) : (
              <>
                {Money.fromString(goalTarget, CURRENCY).format()} is not reached within 100 years
                under this assumption. Try a higher rate or contribution.
              </>
            )}
          </p>
        )}
      </section>

      <p className="mt-10 text-xs text-zinc-400">
        Forecast figures are illustrative estimates, not tax or investment advice — no realized
        gain/loss, tax lots, or 1099 reporting. Forward income reflects published distribution rates
        for today's holdings and may change.
      </p>
    </main>
  );
}

function Tile({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 font-semibold text-lg tabular-nums">{value}</div>
    </div>
  );
}
