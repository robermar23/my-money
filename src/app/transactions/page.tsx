import { TransactionFilters } from "@/app/accounts/[id]/transaction-filters.tsx";
import { listAccounts } from "@/lib/accounts/queries.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { listCategoriesWithGroups } from "@/lib/categories/queries.ts";
import { Money } from "@/lib/money/money.ts";
import { transactionFilterSchema } from "@/lib/schemas/search.ts";
import {
  type TransactionFilters as Filters,
  listTransactions,
} from "@/lib/transactions/queries.ts";
import { toAccountId } from "@/lib/types/ids.ts";
import Link from "next/link";

interface TransactionsPageProps {
  readonly searchParams?: Promise<Record<string, string | undefined>>;
}

/** Filter keys carried through pagination (everything except `page`). */
const FILTER_KEYS = [
  "q",
  "from",
  "to",
  "minAmount",
  "maxAmount",
  "categoryId",
  "accountId",
] as const;

/**
 * Cross-account "All transactions" surface (Phase 12, P12-12, ADR-027) — the
 * "find a transaction without knowing which account" view. It reuses the
 * structured {@link TransactionFilters} bar (with the account selector enabled)
 * and the refactored `listTransactions` in all-accounts mode (`accountId`
 * omitted unless the selector narrows it). Each row links to its account.
 *
 * Amounts are shown with their **stored sign** (credit = +, debit = −); unlike
 * the per-account credit-card view there is no per-account sign flip here, since
 * rows span account types. State lives entirely in the URL.
 */
export default async function TransactionsPage(
  props: TransactionsPageProps,
): Promise<React.JSX.Element> {
  await requireUser();
  const search = (await props.searchParams) ?? {};

  // Invalid combos (from > to, min > max) fall back to no filters + page 1; the
  // bar still echoes the raw URL values so the user can correct them.
  const parsed = transactionFilterSchema.safeParse(search);
  const data = parsed.success ? parsed.data : null;
  const page = data?.page ?? 1;
  const accountId = data?.accountId ? toAccountId(data.accountId) : undefined;
  const filters: Filters | undefined = data
    ? {
        q: data.q,
        from: data.from,
        to: data.to,
        minAmount: data.minAmount,
        maxAmount: data.maxAmount,
        categoryId: data.categoryId,
      }
    : undefined;
  const filtersActive = FILTER_KEYS.some((k) => (search[k] ?? "") !== "");

  const [result, accountList, categoryData] = await Promise.all([
    listTransactions({ accountId, filters, page }),
    listAccounts(),
    listCategoriesWithGroups(),
  ]);

  const accountOptions = accountList.map((a) => ({ id: a.id, name: a.name }));
  const categoryOptions = categoryData.categories.map((c) => ({
    id: c.id,
    name: c.name,
    groupName: c.groupName,
    kind: c.kind,
  }));

  // Pagination links keep every active filter; only `page` changes.
  const filterParams = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = search[k];
    if (v) filterParams.set(k, v);
  }
  const hrefFor = (target: number): string => {
    const sp = new URLSearchParams(filterParams.toString());
    if (target > 1) sp.set("page", String(target));
    const qs = sp.toString();
    return qs ? `/transactions?${qs}` : "/transactions";
  };

  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold text-2xl tracking-tight">
          All transactions <span className="text-base text-zinc-500">({result.totalCount})</span>
        </h1>
        <Link href="/accounts" className="text-sm text-zinc-500 hover:underline">
          Accounts →
        </Link>
      </div>

      <p className="mt-1 text-sm text-zinc-500">
        Search and filter transactions across every account. Amounts show their stored sign (credits
        positive, debits negative).
      </p>

      <div className="mt-4">
        <TransactionFilters categories={categoryOptions} accounts={accountOptions} />
      </div>

      {result.rows.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-500">
          {filtersActive
            ? "No transactions match these filters."
            : "No transactions yet. Import a QFX or CSV export into an account to get started."}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="text-left text-xs text-zinc-500 uppercase">
              <tr>
                <th className="py-1.5">Date</th>
                <th className="py-1.5">Payee</th>
                <th data-tour="transactions-account-column" className="py-1.5">
                  Account
                </th>
                <th className="py-1.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {result.rows.map((t) => {
                const amount = Money.fromString(t.amount, "USD");
                return (
                  <tr key={t.id}>
                    <td className="py-1.5 font-mono">{t.postedAt}</td>
                    <td className="py-1.5">
                      <div>{t.name}</div>
                      {t.memo && <div className="text-xs text-zinc-500">{t.memo}</div>}
                    </td>
                    <td className="py-1.5">
                      <Link href={`/accounts/${t.accountId}`} className="hover:underline">
                        {t.accountName}
                      </Link>
                    </td>
                    <td
                      className={`py-1.5 text-right font-mono ${
                        amount.isNegative() ? "text-red-700 dark:text-red-300" : ""
                      }`}
                    >
                      {amount.format()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {result.totalPages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-xs text-zinc-500">
          <Link
            href={hrefFor(page - 1)}
            aria-disabled={page <= 1}
            className={page <= 1 ? "pointer-events-none opacity-30" : "hover:underline"}
          >
            ← Newer
          </Link>
          <span>
            Page {page} of {result.totalPages}
          </span>
          <Link
            href={hrefFor(page + 1)}
            aria-disabled={page >= result.totalPages}
            className={
              page >= result.totalPages ? "pointer-events-none opacity-30" : "hover:underline"
            }
          >
            Older →
          </Link>
        </nav>
      )}
    </main>
  );
}
