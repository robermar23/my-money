import { requireUser } from "@/lib/auth/require-user.ts";
import { type BudgetLine, budgetVsActual } from "@/lib/budgets/queries.ts";
import { MONTH_RE } from "@/lib/schemas/budget.ts";
import type { Metadata } from "next";
import Link from "next/link";
import { BudgetMonthNav } from "./budget-month-nav.tsx";
import { BudgetRow } from "./budget-row.tsx";

export const metadata: Metadata = { title: "Budgets" };

const CURRENCY = "USD";

interface PageProps {
  readonly searchParams?: Promise<{ month?: string }>;
}

function fmt0(value: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: CURRENCY,
    maximumFractionDigits: 0,
  }).format(Number(value));
}

/** Current calendar month as `YYYY-MM` (UTC). */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Group lines by their group, preserving the sorted order of `lines`. */
function groupLines(
  lines: readonly BudgetLine[],
): { key: string; name: string; rows: BudgetLine[] }[] {
  const groups: { key: string; name: string; rows: BudgetLine[] }[] = [];
  const index = new Map<string, number>();
  for (const l of lines) {
    const key = l.groupId ?? "";
    let i = index.get(key);
    if (i === undefined) {
      i = groups.length;
      index.set(key, i);
      groups.push({ key, name: l.groupName ?? "Ungrouped", rows: [] });
    }
    groups[i]?.rows.push(l);
  }
  return groups;
}

export default async function BudgetsPage(props: PageProps): Promise<React.JSX.Element> {
  await requireUser();
  const search = (await props.searchParams) ?? {};
  const month = search.month && MONTH_RE.test(search.month) ? search.month : currentMonth();

  const data = await budgetVsActual(month);
  const groups = groupLines(data.lines);
  const rollupByGroup = new Map(data.groups.map((g) => [g.groupId ?? "", g]));

  const overTotal = Number(data.totals.remaining) < 0;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-semibold text-2xl tracking-tight">Budgets</h1>
        <Link href="/analysis" className="text-sm text-zinc-500 hover:underline">
          ← Analysis
        </Link>
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        Simple monthly spending targets per category. Actuals are computed from this month's
        transactions (transfers excluded).
      </p>

      <div className="mt-4 flex items-center justify-between">
        <BudgetMonthNav month={month} />
        <div className="text-right text-sm">
          <span className="text-zinc-500">Total </span>
          <span className="font-mono tabular-nums">{fmt0(data.totals.actual)}</span>
          <span className="text-zinc-400"> / {fmt0(data.totals.target)}</span>
          <span className={overTotal ? "ml-2 text-red-600" : "ml-2 text-emerald-600"}>
            {overTotal
              ? `${fmt0(String(-Number(data.totals.remaining)))} over`
              : `${fmt0(data.totals.remaining)} left`}
          </span>
          {data.totals.projected !== null && (
            <div className="text-xs text-zinc-400">
              ~{fmt0(data.totals.projected)} projected at current run-rate
            </div>
          )}
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">
          No expense categories yet. Add categories on the{" "}
          <Link href="/settings/categories" className="hover:underline">
            Categories
          </Link>{" "}
          page first.
        </p>
      ) : (
        <div className="mt-6 space-y-6">
          {groups.map((g) => {
            const rollup = rollupByGroup.get(g.key);
            return (
              <section key={g.key}>
                <div className="flex items-baseline justify-between border-zinc-200 border-b pb-1 dark:border-zinc-800">
                  <h2 className="font-medium text-sm">{g.name}</h2>
                  {rollup && (
                    <span className="text-xs text-zinc-500">
                      {fmt0(rollup.actual)} / {fmt0(rollup.target)}
                    </span>
                  )}
                </div>
                <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
                  {g.rows.map((line) => (
                    <BudgetRow key={line.categoryId} line={line} currency={CURRENCY} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
