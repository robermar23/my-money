import { listAccounts } from "@/lib/accounts/queries.ts";
import { type MonthlyForecast, forecastMonthlySpend } from "@/lib/analytics/forecast.ts";
import { resolveRange } from "@/lib/analytics/range.ts";
import {
  type MonthlyTotals,
  type SpendRow,
  spendByCategory,
  spendByMonth,
  spendingSummary,
} from "@/lib/analytics/spending.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { Money } from "@/lib/money/money.ts";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AnalysisControls } from "./analysis-controls.tsx";
import { CategoryBreakdownChart } from "./category-breakdown-chart.tsx";
import { NetWorthSentence } from "./net-worth-sentence.tsx";
import { SpendByMonthChart } from "./spend-by-month-chart.tsx";

export const metadata: Metadata = { title: "Analysis" };

const CURRENCY = "USD";
const UUID_RE = /^[0-9a-f-]{36}$/i;
/** Max categories charted individually; the remainder is lumped into "Other". */
const TOP_N = 10;

interface PageProps {
  readonly searchParams?: Promise<{
    range?: string;
    from?: string;
    to?: string;
    account?: string;
    groupBy?: string;
  }>;
}

function fmt0(value: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: CURRENCY,
    maximumFractionDigits: 0,
  }).format(Number(value));
}

/** Build top-N (+ "Other") slices for the donut from sorted expense rows. */
function donutSlices(expense: readonly SpendRow[]): { id: string; name: string; value: number }[] {
  const top = expense.slice(0, TOP_N);
  const slices = top.map((r) => ({ id: r.id, name: r.name, value: Number(r.total) }));
  const rest = expense.slice(TOP_N);
  if (rest.length > 0) {
    const other = Money.sum(
      rest.map((r) => Money.fromString(r.total, CURRENCY)),
      CURRENCY,
    );
    slices.push({ id: "__other__", name: "Other", value: Number(other.toString()) });
  }
  return slices;
}

/** Assemble the stacked-bar dataset + its category series (top-N + "Other"). */
/** A chart row: month + net + one numeric key per charted category. */
type MonthRow = { month: string; net: number } & Record<string, number | string>;

/** Next `YYYY-MM` after `month` (UTC, no TZ drift). */
function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7)); // 1-12 → next is index `mon` (0-based)
  return new Date(Date.UTC(year, mon, 1)).toISOString().slice(0, 7);
}

/**
 * Build a chart row from a `byCategory` map using the chosen top-N split, so the
 * projected month stacks the same series as the actual months.
 */
function chartRow(
  month: string,
  net: string,
  byCategory: Record<string, string>,
  top: readonly SpendRow[],
  restIds: readonly string[],
): MonthRow {
  const row: MonthRow = { month, net: Number(net) };
  for (const c of top) row[c.id] = Number(byCategory[c.id] ?? "0");
  if (restIds.length > 0) {
    const other = Money.sum(
      restIds.map((id) => Money.fromString(byCategory[id] ?? "0", CURRENCY)),
      CURRENCY,
    );
    row.__other__ = Number(other.toString());
  }
  return row;
}

function monthSeries(
  months: readonly MonthlyTotals[],
  expense: readonly SpendRow[],
  forecast?: MonthlyForecast,
): {
  data: MonthRow[];
  categories: { id: string; name: string }[];
  projectedCount: number;
} {
  const top = expense.slice(0, TOP_N);
  const restIds = expense.slice(TOP_N).map((r) => r.id);
  const hasOther = restIds.length > 0;

  const categories = top.map((r) => ({ id: r.id, name: r.name }));
  if (hasOther) categories.push({ id: "__other__", name: "Other" });

  const data: MonthRow[] = months.map((m) => chartRow(m.month, m.net, m.byCategory, top, restIds));

  // Append the trailing-average forecast as one projected month, if we have a
  // basis and at least one actual month to extend from.
  let projectedCount = 0;
  const last = months.at(-1);
  if (forecast && forecast.basisMonths > 0 && last) {
    data.push(chartRow(nextMonth(last.month), forecast.net, forecast.byCategory, top, restIds));
    projectedCount = 1;
  }

  return { data, categories, projectedCount };
}

export default async function AnalysisPage(props: PageProps): Promise<React.JSX.Element> {
  await requireUser();
  const search = (await props.searchParams) ?? {};
  const range = resolveRange(search);
  const accountId = search.account && UUID_RE.test(search.account) ? search.account : null;
  const accountIds = accountId ? [accountId] : undefined;
  const groupBy = search.groupBy === "group" ? "group" : "category";

  const [summary, rows, months, accounts] = await Promise.all([
    spendingSummary({ from: range.from, to: range.to, accountIds }),
    spendByCategory({ from: range.from, to: range.to, accountIds, groupBy }),
    spendByMonth({ from: range.from, to: range.to, accountIds }),
    listAccounts(),
  ]);

  const expenseRows = rows.filter((r) => r.kind === "expense");
  const slices = donutSlices(expenseRows);
  const forecast = forecastMonthlySpend(months);
  const series = monthSeries(months, expenseRows, forecast);

  // Savings rate = net / income. Display-only ratio; guarded against /0.
  const incomeNum = Number(summary.income);
  const savingsRate = incomeNum > 0 ? (Number(summary.net) / incomeNum) * 100 : null;

  const groupHref = (g: string): string => {
    const sp = new URLSearchParams();
    if (search.range) sp.set("range", search.range);
    if (search.from) sp.set("from", search.from);
    if (search.to) sp.set("to", search.to);
    if (accountId) sp.set("account", accountId);
    sp.set("groupBy", g);
    return `/analysis?${sp.toString()}`;
  };

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="font-semibold text-2xl tracking-tight">Analysis</h1>
      <p className="mt-1 text-sm text-zinc-500">{range.label}</p>

      <div className="mt-4">
        <AnalysisControls
          activeKey={range.key}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
          activeAccountId={accountId}
          from={range.from}
          to={range.to}
        />
      </div>

      {summary.uncategorizedCount > 0 && (
        <Link
          href="/analysis/review"
          className="mt-4 block rounded-md bg-amber-50 px-3 py-2 text-amber-800 text-sm hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
        >
          {summary.uncategorizedCount} uncategorized transaction
          {summary.uncategorizedCount === 1 ? "" : "s"} ({fmt0(summary.uncategorizedOutflow)} of
          spending) aren't counted below. Review them →
        </Link>
      )}

      {/* Summary tiles */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Income" value={fmt0(summary.income)} tone="text-emerald-600" />
        <Tile label="Expense" value={fmt0(summary.expense)} tone="text-red-600" />
        <Tile
          label="Net"
          value={fmt0(summary.net)}
          tone={Money.fromString(summary.net, CURRENCY).isNegative() ? "text-red-600" : ""}
        />
        <Tile
          label="Savings rate"
          value={savingsRate === null ? "—" : `${savingsRate.toFixed(0)}%`}
        />
      </div>

      {/* P17-23 — the pointer to the net-worth decomposition. Streamed: a full
          decomposition is ~10 reads and must not delay the spending page. */}
      <Suspense fallback={null}>
        <NetWorthSentence from={range.from} to={range.to} />
      </Suspense>

      {/* Spend over time */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Spending by month</h2>
          {series.projectedCount > 0 && (
            <span className="text-xs text-zinc-400">
              Dashed/dimmed = projected (trailing 3-month average)
            </span>
          )}
        </div>
        <div className="mt-3">
          <SpendByMonthChart
            data={series.data}
            categories={series.categories}
            currency={CURRENCY}
            projectedCount={series.projectedCount}
          />
        </div>
      </section>

      {/* Breakdown + table */}
      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div>
          <div className="flex items-center justify-between">
            <h2 className="font-medium">{groupBy === "group" ? "By group" : "By category"}</h2>
            <div className="flex gap-1.5 text-xs">
              <Link
                href={groupHref("category")}
                className={groupBy === "category" ? "font-medium" : "text-zinc-500 hover:underline"}
              >
                Categories
              </Link>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <Link
                href={groupHref("group")}
                className={groupBy === "group" ? "font-medium" : "text-zinc-500 hover:underline"}
              >
                Groups
              </Link>
            </div>
          </div>
          <div className="mt-3">
            <CategoryBreakdownChart slices={slices} currency={CURRENCY} />
          </div>
        </div>

        <div>
          <h2 className="font-medium">Spending detail</h2>
          {expenseRows.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">No categorized spending in this range.</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {expenseRows.map((r) => (
                  <tr key={r.id || r.name}>
                    <td className="py-2">
                      {groupBy === "category" ? (
                        <Link href={`/analysis/category/${r.id}`} className="hover:underline">
                          {r.name}
                        </Link>
                      ) : (
                        r.name
                      )}
                      {r.groupName && groupBy === "category" && (
                        <span className="ml-2 text-xs text-zinc-400">{r.groupName}</span>
                      )}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">{fmt0(r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}

function Tile({
  label,
  value,
  tone = "",
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 font-semibold text-lg tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}
