import { db } from "@/db/client.ts";
import { accountSnapshots } from "@/db/schema/index.ts";
import { listAccounts } from "@/lib/accounts/queries.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { Money } from "@/lib/money/money.ts";
import { toAccountId } from "@/lib/types/ids.ts";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { ReopenAccountButton } from "./reopen-account-button.tsx";

interface AccountsPageProps {
  readonly searchParams?: Promise<{ closed?: string }>;
}

const TYPE_LABEL: Record<string, string> = {
  depository: "Cash",
  credit_card: "Credit card",
  investment: "Investment",
  crypto_ira: "Crypto / metals IRA",
  loan: "Loan",
  property: "Property",
};

async function getLatestBalanceString(accountId: string): Promise<string | null> {
  const [snap] = await db
    .select({ balance: accountSnapshots.balance })
    .from(accountSnapshots)
    .where(eq(accountSnapshots.accountId, accountId))
    .orderBy(desc(accountSnapshots.date))
    .limit(1);
  return snap?.balance ?? null;
}

export default async function AccountsPage(props: AccountsPageProps): Promise<React.JSX.Element> {
  await requireUser();
  const search = (await props.searchParams) ?? {};
  const showClosed = search.closed === "1";

  const all = await listAccounts();
  // Closed accounts are hidden by default (P7-04); a URL toggle reveals them.
  const visible = showClosed ? all : all.filter((a) => a.closedAt === null);
  const closedCount = all.length - all.filter((a) => a.closedAt === null).length;

  // Fetch latest balance per account in parallel.
  const enriched = await Promise.all(
    visible.map(async (a) => ({
      account: a,
      latestBalance: await getLatestBalanceString(a.id),
    })),
  );

  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold text-2xl tracking-tight">Accounts</h1>
        <div className="flex items-center gap-4">
          {closedCount > 0 && (
            <Link
              href={showClosed ? "/accounts" : "/accounts?closed=1"}
              className="text-sm text-zinc-500 hover:underline"
            >
              {showClosed ? "Hide closed" : `Show closed (${closedCount})`}
            </Link>
          )}
          <Link href="/investments" className="text-sm text-zinc-500 hover:underline">
            Investments →
          </Link>
          <Link
            href="/accounts/new"
            className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Add account
          </Link>
        </div>
      </div>

      {enriched.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">
          No accounts yet. Add your first account to start tracking your net worth.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="border-zinc-200 border-b text-left text-xs text-zinc-500 uppercase dark:border-zinc-800">
              <tr>
                <th className="py-2">Name</th>
                <th className="py-2">Institution</th>
                <th className="py-2">Type</th>
                <th className="py-2 text-right">Latest balance</th>
                <th className="py-2 text-right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {enriched.map(({ account, latestBalance }) => {
                const closed = account.closedAt !== null;
                return (
                  <tr key={account.id} className={closed ? "text-zinc-400 dark:text-zinc-600" : ""}>
                    <td className="py-3">
                      <Link
                        href={`/accounts/${account.id}`}
                        className="font-medium hover:underline"
                      >
                        {account.name}
                      </Link>
                      {closed && (
                        <span className="ml-2 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-600 uppercase dark:bg-zinc-800 dark:text-zinc-400">
                          Closed
                        </span>
                      )}
                    </td>
                    <td className="py-3 text-zinc-600 dark:text-zinc-400">{account.institution}</td>
                    <td className="py-3 text-zinc-600 dark:text-zinc-400">
                      {TYPE_LABEL[account.type] ?? account.type}
                    </td>
                    <td className="py-3 text-right font-mono">
                      {latestBalance
                        ? Money.fromString(latestBalance, account.currency).format()
                        : "—"}
                    </td>
                    <td className="py-3 text-right">
                      {closed && <ReopenAccountButton accountId={account.id} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

// Suppress unused-import lint while keeping the helper exports referenced.
void toAccountId;
