import { requireUser } from "@/lib/auth/require-user.ts";
import { valueHolding } from "@/lib/holdings/value.ts";
import { allocationByAssetClass } from "@/lib/investments/allocation.ts";
import { gainLoss, portfolioGainLoss } from "@/lib/investments/gain-loss.ts";
import { type IncomePeriod, incomeByPeriod } from "@/lib/investments/income.ts";
import { resolveCostBasis } from "@/lib/investments/lots.ts";
import {
  listInvestmentIncome,
  listInvestmentLots,
  listInvestmentPositions,
} from "@/lib/investments/queries.ts";
import { Money } from "@/lib/money/money.ts";
import Link from "next/link";
import { AllocationChart } from "./allocation-chart.tsx";
import { IncomeChart } from "./income-chart.tsx";

interface InvestmentsPageProps {
  readonly searchParams?: Promise<{ period?: string }>;
}

const PERIODS: readonly IncomePeriod[] = ["month", "quarter", "year"];

function parsePeriod(raw: string | undefined): IncomePeriod {
  return PERIODS.includes(raw as IncomePeriod) ? (raw as IncomePeriod) : "month";
}

export default async function InvestmentsPage(
  props: InvestmentsPageProps,
): Promise<React.JSX.Element> {
  await requireUser();
  const period = parsePeriod((await props.searchParams)?.period);
  const baseCurrency = "USD";
  const today = new Date().toISOString().slice(0, 10);

  const [positions, lots, incomeTxns] = await Promise.all([
    listInvestmentPositions(),
    listInvestmentLots(),
    listInvestmentIncome(),
  ]);

  const lotsByHolding = new Map<string, { quantity: string; costBasisTotal: string }[]>();
  for (const lot of lots) {
    const arr = lotsByHolding.get(lot.holdingId) ?? [];
    arr.push({ quantity: lot.quantity, costBasisTotal: lot.costBasisTotal });
    lotsByHolding.set(lot.holdingId, arr);
  }

  const rows = await Promise.all(
    positions.map(async (p) => {
      const currency = p.accountCurrency;
      const valuation = await valueHolding(p.holding, currency, today);
      const lotInputs = lotsByHolding.get(p.holding.id) ?? [];
      const costBasis = resolveCostBasis({ costBasis: p.holding.costBasis }, lotInputs, currency);
      const priced = valuation.closeUsed !== null || p.holding.assetClass === "cash";
      const gl = priced && costBasis ? gainLoss({ value: valuation.value, costBasis }) : null;
      return { p, valuation, priced, costBasis, gl };
    }),
  );

  // Portfolio totals (gain/loss over basis-known positions).
  const portfolio = portfolioGainLoss(
    rows.map((r) => ({ value: r.valuation.value, costBasis: r.costBasis })),
    baseCurrency,
  );

  // Allocation by asset class (only priced value contributes).
  const slices = allocationByAssetClass(
    rows.map((r) => ({
      assetClass: r.p.holding.assetClass,
      accountId: r.p.accountId,
      value: r.valuation.value,
    })),
    baseCurrency,
  ).map((s) => ({
    label: s.label,
    value: Number(s.value.toString()),
    percent: s.percent,
    valueFormatted: s.value.format(),
  }));

  // Income breakdown.
  const incomePoints = incomeByPeriod(incomeTxns, period, baseCurrency).map((pt) => ({
    period: pt.period,
    dividend: Number(pt.dividend.toString()),
    interest: Number(pt.interest.toString()),
  }));

  // Group rows by account for the positions tables.
  const byAccount = new Map<string, { name: string; currency: string; rows: typeof rows }>();
  for (const r of rows) {
    const g = byAccount.get(r.p.accountId) ?? {
      name: r.p.accountName,
      currency: r.p.accountCurrency,
      rows: [] as typeof rows,
    };
    g.rows.push(r);
    byAccount.set(r.p.accountId, g);
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <Link href="/" className="text-sm text-zinc-500 hover:underline">
        ← Dashboard
      </Link>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">Investments</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Positions, cost basis, and gain/loss across your brokerage, IRA, and crypto accounts.
          </p>
        </div>
        <div className="text-right">
          <div className="font-mono text-3xl tabular-nums">{portfolio.totalValue.format()}</div>
          <div className="mt-0.5 text-sm text-zinc-500">
            Cost basis {portfolio.totalCostBasis ? portfolio.totalCostBasis.format() : "—"}
            {portfolio.absolute && (
              <span
                className={
                  portfolio.absolute.isNegative()
                    ? "ml-2 text-red-600 dark:text-red-400"
                    : "ml-2 text-emerald-600 dark:text-emerald-400"
                }
              >
                {portfolio.absolute.format()} ({portfolio.percent}%)
              </span>
            )}
          </div>
        </div>
      </div>

      {positions.length === 0 ? (
        <p className="mt-8 rounded-md border border-zinc-200 border-dashed p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
          No investment holdings yet. Add a holding on an investment or crypto/metals account, or{" "}
          <Link href="/settings/connections" className="underline">
            connect an investment institution
          </Link>
          .
        </p>
      ) : (
        <>
          <section className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="font-medium text-sm">Asset allocation</h2>
            <div className="mt-3">
              <AllocationChart slices={slices} />
            </div>
          </section>

          {[...byAccount.values()].map((group) => {
            const subtotal = group.rows.reduce(
              (acc, r) => acc.add(r.valuation.value),
              Money.zero(group.currency),
            );
            return (
              <section key={group.name} className="mt-8">
                <div className="flex items-center justify-between">
                  <h2 className="font-medium">{group.name}</h2>
                  <span className="font-mono text-sm text-zinc-600 tabular-nums dark:text-zinc-400">
                    {subtotal.format()}
                  </span>
                </div>
                <table className="mt-3 w-full text-sm">
                  <thead className="text-left text-xs text-zinc-500 uppercase">
                    <tr>
                      <th className="py-2">Symbol</th>
                      <th className="py-2">Name</th>
                      <th className="py-2 text-right">Quantity</th>
                      <th className="py-2 text-right">Price</th>
                      <th className="py-2 text-right">Value</th>
                      <th className="py-2 text-right">Cost basis</th>
                      <th className="py-2 text-right">Gain/Loss</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                    {group.rows.map((r) => (
                      <tr key={r.p.holding.id}>
                        <td className="py-2 font-mono">{r.p.holding.symbol}</td>
                        <td className="py-2 text-zinc-600 dark:text-zinc-400">
                          {r.p.securityName ?? "—"}
                        </td>
                        <td className="py-2 text-right font-mono">{r.p.holding.quantity}</td>
                        <td className="py-2 text-right font-mono">
                          {r.valuation.closeUsed
                            ? Money.fromString(r.valuation.closeUsed, group.currency).format()
                            : "—"}
                        </td>
                        <td className="py-2 text-right font-mono">
                          {r.priced ? r.valuation.value.format() : "—"}
                        </td>
                        <td className="py-2 text-right font-mono">
                          {r.costBasis ? r.costBasis.format() : "—"}
                        </td>
                        <td
                          className={`py-2 text-right font-mono ${
                            r.gl?.absolute
                              ? r.gl.absolute.isNegative()
                                ? "text-red-600 dark:text-red-400"
                                : "text-emerald-600 dark:text-emerald-400"
                              : ""
                          }`}
                        >
                          {r.gl?.absolute ? `${r.gl.absolute.format()} (${r.gl.percent}%)` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })}

          <section className="mt-10">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">Dividend & interest income</h2>
              <div className="flex gap-1 text-sm">
                {PERIODS.map((p) => (
                  <Link
                    key={p}
                    href={`/investments?period=${p}`}
                    className={`rounded-md px-2 py-1 capitalize ${
                      p === period
                        ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    }`}
                  >
                    {p}
                  </Link>
                ))}
              </div>
            </div>
            <div className="mt-3">
              <IncomeChart points={incomePoints} currency={baseCurrency} />
            </div>
          </section>
        </>
      )}
    </main>
  );
}
