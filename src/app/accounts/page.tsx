import { SearchInput } from "@/components/search-input.tsx";
import { buttonClass } from "@/components/ui/button-styles.ts";
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
  readonly searchParams?: Promise<{ closed?: string; q?: string }>;
}

const TYPE_LABEL: Record<string, string> = {
  depository: "Cash",
  credit_card: "Credit card",
  investment: "Investment",
  crypto_ira: "Crypto / metals IRA",
  loan: "Loan",
  property: "Property",
  personal_asset: "Asset",
};

/** Display labels for personal-asset categories (mirrors ASSET_CATEGORIES). */
const ASSET_CATEGORY_LABEL: Record<string, string> = {
  vehicle: "Vehicle",
  watercraft: "Boat & watercraft",
  jewelry: "Jewelry & watches",
  collectible: "Art & collectibles",
  other: "Other",
};

/** An account's newest recorded balance and the day it was recorded for. */
interface LatestBalance {
  readonly balance: string;
  /** ISO `YYYY-MM-DD`. */
  readonly date: string;
}

async function getLatestBalance(accountId: string): Promise<LatestBalance | null> {
  const [snap] = await db
    .select({ balance: accountSnapshots.balance, date: accountSnapshots.date })
    .from(accountSnapshots)
    .where(eq(accountSnapshots.accountId, accountId))
    .orderBy(desc(accountSnapshots.date))
    .limit(1);
  return snap ?? null;
}

/**
 * `"2026-10-09"` → `"Oct 9, 2026"`, in UTC so a stored date never shifts a day.
 *
 * @param isoDate - A snapshot date.
 * @returns The date as the balance's "as of" line shows it.
 */
function asOfLabel(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default async function AccountsPage(props: AccountsPageProps): Promise<React.JSX.Element> {
  await requireUser();
  const search = (await props.searchParams) ?? {};
  const showClosed = search.closed === "1";
  const query = search.q?.trim() ?? "";

  // P12-10 — trigram filter on name/institution/description (composes with the
  // `?closed=` toggle). An unfiltered fetch still backs the closed-count chip so
  // it stays accurate while a query narrows the visible rows.
  const [all, matched] = await Promise.all([
    listAccounts(),
    query ? listAccounts({ q: query }) : Promise.resolve(null),
  ]);
  const source = matched ?? all;
  // Closed accounts are hidden by default (P7-04); a URL toggle reveals them.
  const visible = showClosed ? source : source.filter((a) => a.closedAt === null);
  const closedCount = all.length - all.filter((a) => a.closedAt === null).length;

  // Fetch latest balance per account in parallel.
  const enriched = await Promise.all(
    visible.map(async (a) => ({
      account: a,
      latest: await getLatestBalance(a.id),
    })),
  );

  // The "show/hide closed" toggle preserves the active `?q=` filter.
  const closedParams = new URLSearchParams();
  if (!showClosed) closedParams.set("closed", "1");
  if (query) closedParams.set("q", query);
  const toggleClosedHref = closedParams.toString()
    ? `/accounts?${closedParams.toString()}`
    : "/accounts";

  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold text-2xl tracking-tight">Accounts</h1>
        <div className="flex items-center gap-4">
          {closedCount > 0 && (
            <Link href={toggleClosedHref} className="text-sm text-zinc-500 hover:underline">
              {showClosed ? "Hide closed" : `Show closed (${closedCount})`}
            </Link>
          )}
          <Link
            href="/accounts/new"
            data-tour="accounts-add"
            className={buttonClass({ variant: "secondary" })}
          >
            Add account
          </Link>
        </div>
      </div>

      {all.length > 0 && (
        <div data-tour="accounts-filter" className="mt-6">
          <SearchInput
            placeholder="Filter accounts by name or institution…"
            label="Filter accounts"
            className="max-w-sm"
          />
        </div>
      )}

      {enriched.length === 0 ? (
        query ? (
          <p className="mt-8 text-sm text-zinc-500">
            No accounts match “{query}”.{" "}
            <Link
              href={showClosed ? "/accounts?closed=1" : "/accounts"}
              className="hover:underline"
            >
              Clear filter
            </Link>
          </p>
        ) : (
          <p className="mt-8 text-sm text-zinc-500">
            No accounts yet. Add your first account to start tracking your net worth.
          </p>
        )
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="border-zinc-200 border-b text-left text-xs text-zinc-500 uppercase dark:border-zinc-800">
              <tr>
                <th data-tour="accounts-name" className="py-2">
                  Name
                </th>
                <th className="py-2">Institution</th>
                <th className="py-2">Type</th>
                <th data-tour="accounts-latest-balance" className="py-2 text-right">
                  Latest balance
                </th>
                <th className="py-2 text-right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {enriched.map(({ account, latest }) => {
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
                    <td className="py-3 text-zinc-600 dark:text-zinc-400">
                      {account.type === "personal_asset" && account.assetCategory
                        ? (ASSET_CATEGORY_LABEL[account.assetCategory] ?? account.assetCategory)
                        : account.institution}
                    </td>
                    <td className="py-3 text-zinc-600 dark:text-zinc-400">
                      {TYPE_LABEL[account.type] ?? account.type}
                    </td>
                    <td className="py-3 text-right font-mono">
                      {latest ? (
                        <>
                          {Money.fromString(latest.balance, account.currency).format()}
                          {/* P20 Open Items: "is each one up to date?" needs a date. */}
                          <div className="font-sans text-xs text-zinc-500">
                            as of {asOfLabel(latest.date)}
                          </div>
                        </>
                      ) : (
                        "—"
                      )}
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
