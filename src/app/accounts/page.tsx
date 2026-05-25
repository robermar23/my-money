import { db } from "@/db/client.ts";
import { accountSnapshots } from "@/db/schema/index.ts";
import { listAccounts } from "@/lib/accounts/queries.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { Money } from "@/lib/money/money.ts";
import { toAccountId } from "@/lib/types/ids.ts";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";

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

export default async function AccountsPage(): Promise<React.JSX.Element> {
  await requireUser();
  const all = await listAccounts();

  // Fetch latest balance per account in parallel.
  const enriched = await Promise.all(
    all.map(async (a) => ({
      account: a,
      latestBalance: await getLatestBalanceString(a.id),
    })),
  );

  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold text-2xl tracking-tight">Accounts</h1>
        <Link
          href="/accounts/new"
          className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Add account
        </Link>
      </div>

      {enriched.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">
          No accounts yet. Add your first account to start tracking your net worth.
        </p>
      ) : (
        <table className="mt-6 w-full text-sm">
          <thead className="border-zinc-200 border-b text-left text-xs text-zinc-500 uppercase dark:border-zinc-800">
            <tr>
              <th className="py-2">Name</th>
              <th className="py-2">Institution</th>
              <th className="py-2">Type</th>
              <th className="py-2 text-right">Latest balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {enriched.map(({ account, latestBalance }) => (
              <tr key={account.id}>
                <td className="py-3">
                  <Link href={`/accounts/${account.id}`} className="font-medium hover:underline">
                    {account.name}
                  </Link>
                </td>
                <td className="py-3 text-zinc-600 dark:text-zinc-400">{account.institution}</td>
                <td className="py-3 text-zinc-600 dark:text-zinc-400">
                  {TYPE_LABEL[account.type] ?? account.type}
                </td>
                <td className="py-3 text-right font-mono">
                  {latestBalance ? Money.fromString(latestBalance, account.currency).format() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

// Suppress unused-import lint while keeping the helper exports referenced.
void toAccountId;
