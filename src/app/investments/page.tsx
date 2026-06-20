import { requireUser } from "@/lib/auth/require-user.ts";
import { valueHolding } from "@/lib/holdings/value.ts";
import {
  type AllocationSlice,
  type ValuedHolding,
  allocationByAccount,
  allocationByAssetClass,
  allocationByRegion,
  allocationBySector,
  concentration,
} from "@/lib/investments/allocation.ts";
import { formatQuantity } from "@/lib/investments/format.ts";
import { gainLoss, portfolioGainLoss } from "@/lib/investments/gain-loss.ts";
import { type IncomePeriod, incomeByPeriod } from "@/lib/investments/income.ts";
import { resolveCostBasis } from "@/lib/investments/lots.ts";
import {
  listBalanceOnlyInvestmentAccounts,
  listInvestmentIncome,
  listInvestmentLots,
  listInvestmentPositions,
} from "@/lib/investments/queries.ts";
import { Money } from "@/lib/money/money.ts";
import Link from "next/link";
import { AllocationChart } from "./allocation-chart.tsx";
import { IncomeChart } from "./income-chart.tsx";
import { RefreshPricesButton } from "./refresh-prices-button.tsx";

interface InvestmentsPageProps {
  readonly searchParams?: Promise<{ period?: string; dim?: string }>;
}

const PERIODS: readonly IncomePeriod[] = ["month", "quarter", "year"];

function parsePeriod(raw: string | undefined): IncomePeriod {
  return PERIODS.includes(raw as IncomePeriod) ? (raw as IncomePeriod) : "month";
}

/** Allocation slice dimensions (URL `dim` param, P9-16). */
type SliceDim = "assetClass" | "sector" | "region" | "account";
const SLICE_DIMS: readonly { key: SliceDim; label: string }[] = [
  { key: "assetClass", label: "Asset class" },
  { key: "sector", label: "Sector" },
  { key: "region", label: "Region" },
  { key: "account", label: "Account" },
];

function parseDim(raw: string | undefined): SliceDim {
  return SLICE_DIMS.some((d) => d.key === raw) ? (raw as SliceDim) : "assetClass";
}

export default async function InvestmentsPage(
  props: InvestmentsPageProps,
): Promise<React.JSX.Element> {
  await requireUser();
  const search = (await props.searchParams) ?? {};
  const period = parsePeriod(search.period);
  const dim = parseDim(search.dim);
  const baseCurrency = "USD";
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

  const rows = await Promise.all(
    positions.map(async (p) => {
      const currency = p.accountCurrency;
      const valuation = await valueHolding(p.holding, currency, today);
      // Cash / cash-equivalent positions (e.g. a Fidelity sweep fund like FDRXX)
      // are how money is parked or transferred in before it buys real positions.
      // They have no cost basis or gain/loss: the inflow isn't a "purchase" that
      // can gain or lose. Treating their leftover basis as a loss produces a huge
      // phantom drawdown (and distorts the portfolio total), so suppress it.
      const isCash = p.holding.assetClass === "cash";
      const lotInputs = lotsByHolding.get(p.holding.id) ?? [];
      const costBasis = isCash
        ? null
        : resolveCostBasis({ costBasis: p.holding.costBasis }, lotInputs, currency);
      const priced = valuation.closeUsed !== null || isCash;
      const gl = priced && costBasis ? gainLoss({ value: valuation.value, costBasis }) : null;
      return { p, valuation, priced, costBasis, gl };
    }),
  );

  // Portfolio totals (gain/loss over basis-known positions).
  const portfolio = portfolioGainLoss(
    rows.map((r) => ({ value: r.valuation.value, costBasis: r.costBasis })),
    baseCurrency,
  );

  // Balance-only investment accounts: value (latest snapshot) but no itemized
  // holdings — e.g. a 401k Plaid reports only as a total. Fold their value into
  // the page total so it reconciles with net worth.
  const balanceOnlyInBase = balanceOnly.filter((a) => a.currency === baseCurrency);
  const balanceOnlyTotal = Money.sum(
    balanceOnlyInBase.map((a) => Money.fromString(a.balance, baseCurrency)),
    baseCurrency,
  );
  const totalValue = portfolio.totalValue.add(balanceOnlyTotal);

  // Valued holdings for allocation slicing — priced positions (with enrichment
  // metadata) plus a single "other" bucket per balance-only account, so the
  // donut always sums to the page total regardless of the slice dimension.
  const valued: ValuedHolding[] = [
    ...rows.map((r) => ({
      assetClass: r.p.holding.assetClass,
      accountId: r.p.accountId,
      value: r.valuation.value,
      sector: r.p.sector,
      region: r.p.region,
      assetType: r.p.assetType,
    })),
    ...balanceOnlyInBase.map((a) => ({
      assetClass: "other",
      accountId: a.accountId,
      value: Money.fromString(a.balance, baseCurrency),
      sector: null,
      region: null,
      assetType: null,
    })),
  ];

  const nameByAccountId: Record<string, string> = {};
  for (const r of rows) nameByAccountId[r.p.accountId] = r.p.accountName;
  for (const a of balanceOnlyInBase) nameByAccountId[a.accountId] = a.accountName;

  const allocate = (d: SliceDim): AllocationSlice[] => {
    switch (d) {
      case "sector":
        return allocationBySector(valued, baseCurrency);
      case "region":
        return allocationByRegion(valued, baseCurrency);
      case "account":
        return allocationByAccount(valued, baseCurrency, nameByAccountId);
      default:
        return allocationByAssetClass(valued, baseCurrency);
    }
  };

  const slices = allocate(dim).map((s) => ({
    label: s.label,
    value: Number(s.value.toString()),
    percent: s.percent,
    valueFormatted: s.value.format(),
  }));

  // Concentration — top positions as a share of the whole portfolio. Each priced
  // holding is one position (labeled by symbol); each balance-only account is
  // one position (labeled by name).
  const conc = concentration(
    [
      ...rows.map((r) => ({ label: r.p.holding.symbol, value: r.valuation.value })),
      ...balanceOnlyInBase.map((a) => ({
        label: a.accountName,
        value: Money.fromString(a.balance, baseCurrency),
      })),
    ],
    baseCurrency,
    10,
  );
  const concentrationRows = conc.top.map((row) => ({
    label: row.label,
    valueFormatted: row.value.format(),
    percent: row.percent,
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
          <div className="mt-2 flex items-center gap-3">
            <RefreshPricesButton />
            <Link href="/investments/performance" className="text-sm text-zinc-500 hover:underline">
              Performance →
            </Link>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-3xl tabular-nums">{totalValue.format()}</div>
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

      {positions.length === 0 && balanceOnly.length === 0 ? (
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium text-sm">Allocation</h2>
              <div className="flex flex-wrap gap-1 text-sm">
                {SLICE_DIMS.map((d) => (
                  <Link
                    key={d.key}
                    href={`/investments?period=${period}&dim=${d.key}`}
                    className={`rounded-md px-2 py-1 ${
                      d.key === dim
                        ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    }`}
                  >
                    {d.label}
                  </Link>
                ))}
              </div>
            </div>
            <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <AllocationChart slices={slices} />
              <div>
                <h3 className="text-xs text-zinc-500 uppercase">Top holdings</h3>
                {concentrationRows.length === 0 ? (
                  <p className="mt-2 text-sm text-zinc-500">No priced holdings yet.</p>
                ) : (
                  <>
                    <table className="mt-2 w-full text-sm">
                      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                        {concentrationRows.map((row) => (
                          <tr key={row.label}>
                            <td className="truncate py-1.5 pr-2 font-mono">{row.label}</td>
                            <td className="py-1.5 pr-2 text-right font-mono text-zinc-600 tabular-nums dark:text-zinc-400">
                              {row.valueFormatted}
                            </td>
                            <td className="py-1.5 text-right font-mono tabular-nums">
                              {row.percent}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-2 text-xs text-zinc-500">
                      Top {concentrationRows.length} = {conc.topPercent}% of portfolio.
                    </p>
                  </>
                )}
              </div>
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
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[48rem] table-fixed text-sm">
                    {/* Fixed widths keep every account's table aligned to the same
                        grid (auto layout sizes each table to its own content). */}
                    <colgroup>
                      <col className="w-[10%]" />
                      <col className="w-[24%]" />
                      <col className="w-[13%]" />
                      <col className="w-[10%]" />
                      <col className="w-[13%]" />
                      <col className="w-[13%]" />
                      <col className="w-[17%]" />
                    </colgroup>
                    <thead className="text-left text-xs text-zinc-500 uppercase">
                      <tr>
                        <th className="py-2 pr-2">Symbol</th>
                        <th className="py-2 pr-2">Name</th>
                        <th className="py-2 pr-2 text-right">Quantity</th>
                        <th className="py-2 pr-2 text-right">Price</th>
                        <th className="py-2 pr-2 text-right">Value</th>
                        <th className="py-2 pr-2 text-right">Cost basis</th>
                        <th className="py-2 text-right">Gain/Loss</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                      {group.rows.map((r) => (
                        <tr key={r.p.holding.id}>
                          <td className="truncate py-2 pr-2 font-mono">
                            <Link
                              href={`/investments/security/${r.p.holding.id}`}
                              className="hover:underline"
                            >
                              {r.p.holding.symbol}
                            </Link>
                          </td>
                          <td
                            className="truncate py-2 pr-2 text-zinc-600 dark:text-zinc-400"
                            title={r.p.securityName ?? undefined}
                          >
                            {r.p.securityName ?? "—"}
                          </td>
                          <td className="py-2 pr-2 text-right font-mono tabular-nums">
                            {formatQuantity(r.p.holding.quantity)}
                          </td>
                          <td className="py-2 pr-2 text-right font-mono tabular-nums">
                            {r.valuation.closeUsed
                              ? Money.fromString(r.valuation.closeUsed, group.currency).format()
                              : "—"}
                          </td>
                          <td className="py-2 pr-2 text-right font-mono tabular-nums">
                            {r.priced ? r.valuation.value.format() : "—"}
                          </td>
                          <td className="py-2 pr-2 text-right font-mono tabular-nums">
                            {r.costBasis ? r.costBasis.format() : "—"}
                          </td>
                          <td
                            className={`whitespace-nowrap py-2 text-right font-mono tabular-nums ${
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
                </div>
              </section>
            );
          })}

          {balanceOnly.map((a) => (
            <section key={a.accountId} className="mt-8">
              <div className="flex items-center justify-between">
                <h2 className="font-medium">{a.accountName}</h2>
                <span className="font-mono text-sm text-zinc-600 tabular-nums dark:text-zinc-400">
                  {Money.fromString(a.balance, a.currency).format()}
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                Plaid reports this account's balance but not its individual holdings, so positions
                aren't itemized. The value above is included in the total and your net worth.
              </p>
            </section>
          ))}

          <section className="mt-10">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">Dividend & interest income</h2>
              <div className="flex gap-1 text-sm">
                {PERIODS.map((p) => (
                  <Link
                    key={p}
                    href={`/investments?period=${p}&dim=${dim}`}
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
