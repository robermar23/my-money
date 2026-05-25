import {
  getAccount,
  getLatestSnapshot,
  getLiability,
  listHoldings,
  listSnapshots,
} from "@/lib/accounts/queries.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { Money } from "@/lib/money/money.ts";
import { balanceAtMonth } from "@/lib/mortgage/amortization.ts";
import { toAccountId } from "@/lib/types/ids.ts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BalanceForm } from "./balance-form.tsx";
import { HoldingForm } from "./holding-form.tsx";
import { MortgageForm } from "./mortgage-form.tsx";
import { PropertyForm } from "./property-form.tsx";

interface AccountPageProps {
  readonly params: Promise<{ id: string }>;
}

const TYPE_LABEL: Record<string, string> = {
  depository: "Cash",
  credit_card: "Credit card",
  investment: "Investment",
  crypto_ira: "Crypto / metals IRA",
  loan: "Loan",
  property: "Property",
};

function monthsBetween(startIso: string): number {
  const start = new Date(`${startIso}T00:00:00Z`);
  const now = new Date();
  const months =
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - start.getUTCMonth());
  return Math.max(0, months);
}

export default async function AccountDetailPage(
  props: AccountPageProps,
): Promise<React.JSX.Element> {
  await requireUser();
  const { id } = await props.params;
  const accountId = toAccountId(id);
  const account = await getAccount(accountId);
  if (!account) notFound();

  const [latestSnap, snapshots, accountHoldings, liability] = await Promise.all([
    getLatestSnapshot(accountId),
    listSnapshots(accountId),
    listHoldings(accountId),
    getLiability(accountId),
  ]);

  const showBalanceForm = account.type === "depository" || account.type === "credit_card";
  const showHoldingsForm = account.type === "investment" || account.type === "crypto_ira";
  const showMortgageForm = account.type === "loan";
  const showPropertyForm = account.type === "property";

  // Live mortgage balance via amortization (no DB read of snapshots needed for display).
  const computedLoanBalance = liability
    ? balanceAtMonth(
        Money.fromString(liability.principalAtOrigination, account.currency),
        liability.annualRate,
        liability.termMonths,
        monthsBetween(liability.startDate),
      )
    : null;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <Link href="/accounts" className="text-sm text-zinc-500 hover:underline">
        ← Accounts
      </Link>
      <div className="mt-2 flex items-start justify-between">
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">{account.name}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {account.institution} · {TYPE_LABEL[account.type] ?? account.type} · {account.currency}
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs text-zinc-500 uppercase">Latest</div>
          <div className="font-mono text-xl">
            {computedLoanBalance
              ? computedLoanBalance.negate().format()
              : latestSnap
                ? Money.fromString(latestSnap.balance, account.currency).format()
                : "—"}
          </div>
          {computedLoanBalance && (
            <div className="mt-0.5 text-xs text-zinc-400">computed from amortization</div>
          )}
        </div>
      </div>

      {/* Conditional entry forms by account type */}
      {showBalanceForm && (
        <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="font-medium">Record balance</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Enter the end-of-day balance from your statement or online portal.
          </p>
          <div className="mt-4">
            <BalanceForm accountId={account.id} />
          </div>
        </section>
      )}

      {showHoldingsForm && (
        <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="font-medium">Add or update holding</h2>
          <p className="mt-1 text-sm text-zinc-500">
            For iTrust gold use symbol <code>XAU</code>, asset class <code>physical_metal</code>,
            unit <code>troy_oz</code>.
          </p>
          <div className="mt-4">
            <HoldingForm accountId={account.id} />
          </div>

          {accountHoldings.length > 0 && (
            <table className="mt-6 w-full text-sm">
              <thead className="text-left text-xs text-zinc-500 uppercase">
                <tr>
                  <th className="py-2">Symbol</th>
                  <th className="py-2">Asset class</th>
                  <th className="py-2 text-right">Quantity</th>
                  <th className="py-2">Unit</th>
                  <th className="py-2 text-right">Cost basis</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {accountHoldings.map((h) => (
                  <tr key={h.id}>
                    <td className="py-2 font-mono">{h.symbol}</td>
                    <td className="py-2 text-zinc-600 dark:text-zinc-400">
                      {h.assetClass.replace("_", " ")}
                    </td>
                    <td className="py-2 text-right font-mono">{h.quantity}</td>
                    <td className="py-2 text-zinc-600 dark:text-zinc-400">{h.quantityUnit}</td>
                    <td className="py-2 text-right font-mono">
                      {h.costBasis ? Money.fromString(h.costBasis, account.currency).format() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {showMortgageForm && (
        <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="font-medium">Mortgage parameters</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Once set, the current balance is computed from the amortization schedule. No monthly
            entry needed.
          </p>
          <div className="mt-4">
            <MortgageForm accountId={account.id} existing={liability ?? null} />
          </div>
        </section>
      )}

      {showPropertyForm && (
        <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="font-medium">Record property value</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Update quarterly with your estimated market value (Zillow, Redfin, county assessor,
            etc.).
          </p>
          <div className="mt-4">
            <PropertyForm accountId={account.id} />
          </div>
        </section>
      )}

      {/* Snapshot history */}
      {snapshots.length > 0 && (
        <section className="mt-8">
          <h2 className="font-medium">Snapshot history</h2>
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-xs text-zinc-500 uppercase">
              <tr>
                <th className="py-2">Date</th>
                <th className="py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {snapshots.map((s) => (
                <tr key={s.date}>
                  <td className="py-2 font-mono">{s.date}</td>
                  <td className="py-2 text-right font-mono">
                    {Money.fromString(s.balance, account.currency).format()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
