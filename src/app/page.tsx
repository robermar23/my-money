import { AllocationCard } from "@/components/dashboard/allocation-card.tsx";
import { PerformanceCard } from "@/components/dashboard/performance-card.tsx";
import { RangeToggle } from "@/components/dashboard/range-toggle.tsx";
import { SpendCard } from "@/components/dashboard/spend-card.tsx";
import { requireUser } from "@/lib/auth/require-user.ts";
import type { RangeDelta } from "@/lib/dashboard/delta.ts";
import { loadDashboard } from "@/lib/dashboard/loader.ts";
import { parseDashboardRange } from "@/lib/dashboard/range.ts";
import { Money } from "@/lib/money/money.ts";
import Link from "next/link";
import { NetWorthChart } from "./net-worth-chart.tsx";

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

export default async function HomePage(props: HomePageProps): Promise<React.JSX.Element> {
  // requireUser handles both unauthenticated AND first-run cases by redirecting
  // to /login, which then detects "no user row exists" and renders the
  // first-run "Set a password" copy.
  await requireUser();

  const search = (await props.searchParams) ?? {};
  const range = parseDashboardRange(search.range);
  const data = await loadDashboard(range);
  const { netWorth } = data;

  return (
    <main className="mx-auto max-w-5xl p-6">
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

      <section className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium text-sm">History</h2>
          <RangeToggle active={data.range} />
        </div>
        <div className="mt-2">
          <NetWorthChart points={netWorth.series} currency={data.baseCurrency} />
        </div>
      </section>

      {/* Card grid (extended in Batches 3–5) */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <AllocationCard data={data.allocation} />
        <PerformanceCard data={data.performance} currency={data.baseCurrency} />
        <SpendCard data={data.spending} />
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
        {netWorth.accounts.length === 0 ? (
          <p className="mt-4 rounded-md border border-zinc-200 border-dashed p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
            No accounts yet.{" "}
            <Link href="/accounts/new" className="underline">
              Add your first
            </Link>
            .
          </p>
        ) : (
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
        )}
      </section>
    </main>
  );
}
