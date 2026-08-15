import { AlertsCard } from "@/components/dashboard/alerts-card.tsx";
import { AllocationCard } from "@/components/dashboard/allocation-card.tsx";
import { FirstRunDashboard } from "@/components/dashboard/first-run.tsx";
import { DASHBOARD_GRID, SPAN_STANDARD, SPAN_WIDE } from "@/components/dashboard/grid.ts";
import { IncomeCard } from "@/components/dashboard/income-card.tsx";
import { MoversCard } from "@/components/dashboard/movers-card.tsx";
import { PerformanceCard } from "@/components/dashboard/performance-card.tsx";
import { RangeToggle } from "@/components/dashboard/range-toggle.tsx";
import { SavingsRateCard } from "@/components/dashboard/savings-rate-card.tsx";
import { DashboardSkeleton } from "@/components/dashboard/skeleton.tsx";
import { SpendCard } from "@/components/dashboard/spend-card.tsx";
import { requireUser } from "@/lib/auth/require-user.ts";
import type { RangeDelta } from "@/lib/dashboard/delta.ts";
import { loadDashboard } from "@/lib/dashboard/loader.ts";
import { parseDashboardRange } from "@/lib/dashboard/range.ts";
import { Money } from "@/lib/money/money.ts";
import Link from "next/link";
import { Suspense } from "react";
import { NetWorthChart } from "./net-worth-chart.tsx";

/**
 * The curated dashboard (Phase 13, P13-14, ADR-029).
 *
 * Structure is fixed in this template — full-width net-worth hero, the shared
 * `?range=` history chart, then the responsive card grid, with the accounts
 * table de-emphasized at the bottom. Every figure comes from a single
 * `loadDashboard(range)` call whose ten reads fan out through one `Promise.all`;
 * cards receive typed slices and only format (ADR-029 §2 — cards are dumb, the
 * loader is smart).
 */

const TYPE_LABEL: Record<string, string> = {
  depository: "Cash",
  credit_card: "Credit card",
  investment: "Investment",
  crypto_ira: "Crypto / metals IRA",
  loan: "Loan",
  property: "Property",
};

interface HomePageProps {
  readonly searchParams?: Promise<{ range?: string }>;
}

/**
 * Signed range-delta badge for the hero (P13-06). Renders the {@link RangeDelta}
 * as ▲/▼ + colored magnitude + percent; a flat/insufficient delta is a calm gray
 * dash (ADR-021: no fabricated move). Money math already happened upstream — this
 * only formats.
 */
function DeltaBadge({ delta }: { readonly delta: RangeDelta }): React.JSX.Element {
  if (delta.direction === "flat") {
    return <span className="text-sm text-zinc-500">— no change over range</span>;
  }
  const up = delta.direction === "up";
  const tone = up ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
  // Show the magnitude with the arrow carrying the sign (avoids a double "-").
  const magnitude = delta.abs.isNegative() ? delta.abs.negate() : delta.abs;
  return (
    <span className={`text-sm ${tone}`}>
      {up ? "▲" : "▼"} {magnitude.format()}
      {delta.pct !== null ? ` (${delta.pct}%)` : ""}
    </span>
  );
}

/**
 * The data-dependent half of the dashboard, isolated behind `<Suspense>` so the
 * page shell paints before the loader resolves (P13-15).
 *
 * `searchParams` is awaited *here* rather than in the page for the same reason:
 * reading it in the page would make the shell itself wait on the request.
 */
async function DashboardBody({
  searchParams,
}: {
  readonly searchParams?: Promise<{ range?: string }>;
}): Promise<React.JSX.Element> {
  const search = (await searchParams) ?? {};
  const range = parseDashboardRange(search.range);
  const data = await loadDashboard(range);

  // Brand-new install: one instruction beats seven empty cards (P13-16).
  if (!data.hasAnyAccount) return <FirstRunDashboard />;

  const { netWorth } = data;

  return (
    <>
      {/* Net-worth hero (full width) */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">Net worth</h1>
          <p className="mt-1 text-sm text-zinc-500">
            as of {netWorth.asOf.toLocaleDateString("en-US", { dateStyle: "medium" })}
          </p>
        </div>
        <div className="sm:text-right">
          <div className="font-mono text-3xl tabular-nums sm:text-4xl">
            {netWorth.total.format()}
          </div>
          <div className="mt-1">
            <DeltaBadge delta={netWorth.delta} />
          </div>
        </div>
      </div>

      {/* Shared range control — drives the hero history and the performance card */}
      <section className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium text-sm">History</h2>
          <RangeToggle active={data.range} />
        </div>
        <div className="mt-2">
          <NetWorthChart points={netWorth.series} currency={data.baseCurrency} />
        </div>
      </section>

      {/*
        Curated card grid (ADR-029 §1). Order is deliberate and fixed:
        the two chart-bearing investment cards lead at half-width, then the
        numeric cards run three-up — spending and income (cash flow), then
        alerts and movers (things to look at).
      */}
      <div className={`mt-6 ${DASHBOARD_GRID}`}>
        <AllocationCard data={data.allocation} className={SPAN_WIDE} />
        <PerformanceCard
          data={data.performance}
          currency={data.baseCurrency}
          className={SPAN_WIDE}
        />
        <SpendCard data={data.spending} className={SPAN_STANDARD} />
        <IncomeCard data={data.income} className={SPAN_STANDARD} />
        <AlertsCard data={data.alerts} className={SPAN_STANDARD} />
        <MoversCard data={data.movers} className={SPAN_STANDARD} />
        {/* Savings rate (P14-17) — fills the column Phase 13 reserved beside
            the movers card (P13-13). */}
        <SavingsRateCard data={data.savingsRate} className={SPAN_STANDARD} />
      </div>

      {/* Accounts table — still useful, de-emphasized below the cards */}
      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm text-zinc-500">Accounts</h2>
          <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 text-sm">
            <Link href="/investments" className="text-zinc-500 hover:underline">
              Investments →
            </Link>
            <Link href="/accounts" className="text-zinc-500 hover:underline">
              Manage →
            </Link>
          </div>
        </div>
        {/* No empty branch: zero accounts is the first-run state handled above. */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[28rem] text-sm">
            <thead className="text-left text-xs text-zinc-500 uppercase">
              <tr>
                <th className="py-2">Account</th>
                <th className="py-2">Type</th>
                <th className="py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {netWorth.accounts.map((item) => (
                <tr key={item.accountId}>
                  <td className="py-2">
                    <Link
                      href={`/accounts/${item.accountId}`}
                      className="font-medium hover:underline"
                    >
                      {item.accountName}
                    </Link>
                  </td>
                  <td className="py-2 text-zinc-600 dark:text-zinc-400">
                    {TYPE_LABEL[item.accountType] ?? item.accountType}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {Money.fromString(item.balance.toString(), item.currency).format()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export default async function HomePage(props: HomePageProps): Promise<React.JSX.Element> {
  // requireUser handles both unauthenticated AND first-run cases by redirecting
  // to /login, which then detects "no user row exists" and renders the
  // first-run "Set a password" copy. It gates the shell deliberately — nothing
  // streams to an unauthenticated visitor.
  await requireUser();

  return (
    <main className="mx-auto max-w-5xl p-6">
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardBody searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}
