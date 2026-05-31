import {
  getAccount,
  getLatestSnapshot,
  getLiability,
  listHoldings,
  listSnapshots,
} from "@/lib/accounts/queries.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { valueHolding } from "@/lib/holdings/value.ts";
import { Money } from "@/lib/money/money.ts";
import { balanceAtMonth } from "@/lib/mortgage/amortization.ts";
import { distinctCategories, listTransactions } from "@/lib/transactions/queries.ts";
import { toAccountId } from "@/lib/types/ids.ts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BalanceForm } from "./balance-form.tsx";
import { HoldingForm } from "./holding-form.tsx";
import { MortgageForm } from "./mortgage-form.tsx";
import { PropertyForm } from "./property-form.tsx";
import { ReconciliationBanner } from "./reconciliation-banner.tsx";
import { TransactionsSection } from "./transactions-section.tsx";

interface AccountPageProps {
  readonly params: Promise<{ id: string }>;
  readonly searchParams?: Promise<{ page?: string; imported?: string }>;
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
  const search = (await props.searchParams) ?? {};
  const page = search.page ? Math.max(1, Number.parseInt(search.page, 10)) : 1;
  const justImported = search.imported ? Number.parseInt(search.imported, 10) : null;
  const accountId = toAccountId(id);
  const account = await getAccount(accountId);
  if (!account) notFound();

  const showTransactions =
    account.type === "depository" ||
    account.type === "credit_card" ||
    account.type === "investment";

  const [latestSnap, snapshots, accountHoldings, liability, txnResult, categorySuggestions] =
    await Promise.all([
      getLatestSnapshot(accountId),
      listSnapshots(accountId),
      listHoldings(accountId),
      getLiability(accountId),
      showTransactions
        ? listTransactions({ accountId, page })
        : Promise.resolve({ rows: [], totalCount: 0, page: 1, pageSize: 50, totalPages: 1 }),
      showTransactions ? distinctCategories() : Promise.resolve([] as string[]),
    ]);

  // Phase 2: price each holding using cached `prices` (closeUsed: null means
  // no price has been fetched yet — UI displays "—" for value).
  const todayIso = new Date().toISOString().slice(0, 10);
  const valuations = await Promise.all(
    accountHoldings.map((h) => valueHolding(h, account.currency, todayIso)),
  );
  const holdingsTotal = valuations.reduce(
    (acc, v) => acc.add(v.value),
    Money.zero(account.currency),
  );

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
              : showHoldingsForm && !holdingsTotal.isZero()
                ? holdingsTotal.format()
                : latestSnap
                  ? Money.fromString(latestSnap.balance, account.currency).format()
                  : "—"}
          </div>
          {computedLoanBalance && (
            <div className="mt-0.5 text-xs text-zinc-400">computed from amortization</div>
          )}
        </div>
      </div>

      {justImported !== null && justImported > 0 && (
        <div className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-emerald-800 text-sm dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          Imported {justImported} transaction{justImported === 1 ? "" : "s"}.
        </div>
      )}

      {(account.type === "depository" || account.type === "credit_card") && (
        <ReconciliationBanner accountId={account.id} currency={account.currency} />
      )}

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
                  <th className="py-2 text-right">Latest price</th>
                  <th className="py-2 text-right">Value</th>
                  <th className="py-2 text-right">Cost basis</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {valuations.map((v) => (
                  <tr key={v.holding.id}>
                    <td className="py-2 font-mono">{v.holding.symbol}</td>
                    <td className="py-2 text-zinc-600 dark:text-zinc-400">
                      {v.holding.assetClass.replace("_", " ")}
                    </td>
                    <td className="py-2 text-right font-mono">{v.holding.quantity}</td>
                    <td className="py-2 text-zinc-600 dark:text-zinc-400">
                      {v.holding.quantityUnit}
                    </td>
                    <td className="py-2 text-right font-mono">
                      {v.closeUsed ? Money.fromString(v.closeUsed, account.currency).format() : "—"}
                    </td>
                    <td className="py-2 text-right font-mono">
                      {v.closeUsed || v.holding.assetClass === "cash" ? v.value.format() : "—"}
                    </td>
                    <td className="py-2 text-right font-mono">
                      {v.holding.costBasis
                        ? Money.fromString(v.holding.costBasis, account.currency).format()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-zinc-200 border-t dark:border-zinc-800">
                <tr>
                  <td className="py-2 font-medium" colSpan={5}>
                    Total
                  </td>
                  <td className="py-2 text-right font-medium font-mono">
                    {holdingsTotal.format()}
                  </td>
                  <td />
                </tr>
              </tfoot>
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

      {/* Transactions table for cash + credit + investment accounts */}
      {showTransactions && (
        <TransactionsSection
          accountId={account.id}
          accountCurrency={account.currency}
          flipSign={account.type === "credit_card"}
          rows={txnResult.rows}
          suggestions={categorySuggestions}
          page={txnResult.page}
          totalPages={txnResult.totalPages}
          totalCount={txnResult.totalCount}
        />
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
