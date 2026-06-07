import { requireUser } from "@/lib/auth/require-user.ts";
import { Money } from "@/lib/money/money.ts";
import { computeNetWorth, netWorthSeries } from "@/lib/net-worth/compute.ts";
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

export default async function HomePage(): Promise<React.JSX.Element> {
  // requireUser handles both unauthenticated AND first-run cases by redirecting
  // to /login, which then detects "no user row exists" and renders the
  // first-run "Set a password" copy.
  await requireUser();

  const baseCurrency = "USD";
  const [nw, series] = await Promise.all([
    computeNetWorth(new Date(), baseCurrency),
    netWorthSeries(baseCurrency),
  ]);

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">Net worth</h1>
          <p className="mt-1 text-sm text-zinc-500">
            as of {nw.asOf.toLocaleDateString("en-US", { dateStyle: "medium" })}
          </p>
        </div>
        <div className="text-right">
          <div className="font-mono text-4xl tabular-nums">{nw.total.format()}</div>
        </div>
      </div>

      <section className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="font-medium text-sm">History</h2>
        <div className="mt-2">
          <NetWorthChart points={series} currency={baseCurrency} />
        </div>
      </section>

      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Accounts</h2>
          <div className="flex gap-4 text-sm">
            <Link href="/investments" className="text-zinc-500 hover:underline">
              Investments →
            </Link>
            <Link href="/accounts" className="text-zinc-500 hover:underline">
              Manage →
            </Link>
          </div>
        </div>
        {nw.items.length === 0 ? (
          <p className="mt-4 rounded-md border border-zinc-200 border-dashed p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
            No accounts yet.{" "}
            <Link href="/accounts/new" className="underline">
              Add your first
            </Link>
            .
          </p>
        ) : (
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-xs text-zinc-500 uppercase">
              <tr>
                <th className="py-2">Account</th>
                <th className="py-2">Type</th>
                <th className="py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {nw.items.map((item) => (
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
        )}
      </section>
    </main>
  );
}
