import type { CategoryOption } from "@/components/category-picker.tsx";
import type { Transaction } from "@/db/schema/index.ts";
import { Money } from "@/lib/money/money.ts";
import Link from "next/link";
import { CategoryCell } from "./category-cell.tsx";

interface Props {
  readonly accountId: string;
  readonly accountCurrency: string;
  readonly flipSign: boolean;
  readonly rows: readonly Transaction[];
  readonly categories: readonly CategoryOption[];
  readonly page: number;
  readonly totalPages: number;
  readonly totalCount: number;
}

/**
 * Server-rendered transactions table. Pagination is via URL search params so
 * the URL is shareable / refresh-stable; the inline category cell is the only
 * Client Component island.
 */
export function TransactionsSection({
  accountId,
  accountCurrency,
  flipSign,
  rows,
  categories,
  page,
  totalPages,
  totalCount,
}: Props): React.JSX.Element {
  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between">
        <h2 className="font-medium">
          Transactions <span className="text-xs text-zinc-500">({totalCount})</span>
        </h2>
        <Link
          href={`/accounts/${accountId}/import`}
          className="rounded-md border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Import file
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">
          No transactions yet. Drop in a QFX or CSV export to populate this account.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="text-left text-xs text-zinc-500 uppercase">
              <tr>
                <th className="py-1.5">Date</th>
                <th className="py-1.5">Payee</th>
                <th className="py-1.5">Category</th>
                <th className="py-1.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {rows.map((t) => {
                const displayAmount = flipSign
                  ? Money.fromString(t.amount, accountCurrency).negate()
                  : Money.fromString(t.amount, accountCurrency);
                return (
                  <tr key={t.id}>
                    <td className="py-1.5 font-mono">{t.postedAt}</td>
                    <td className="py-1.5">
                      <div>{t.name}</div>
                      {t.memo && <div className="text-xs text-zinc-500">{t.memo}</div>}
                    </td>
                    <td className="py-1.5">
                      <CategoryCell
                        accountId={accountId}
                        transactionId={t.id}
                        currentId={t.categoryId}
                        currentName={t.category}
                        categories={categories}
                      />
                    </td>
                    <td
                      className={`py-1.5 text-right font-mono ${
                        displayAmount.isNegative() ? "text-red-700 dark:text-red-300" : ""
                      }`}
                    >
                      {displayAmount.format()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-xs text-zinc-500">
          <Link
            href={page > 1 ? `/accounts/${accountId}?page=${page - 1}` : `/accounts/${accountId}`}
            aria-disabled={page <= 1}
            className={page <= 1 ? "pointer-events-none opacity-30" : "hover:underline"}
          >
            ← Newer
          </Link>
          <span>
            Page {page} of {totalPages}
          </span>
          <Link
            href={`/accounts/${accountId}?page=${page + 1}`}
            aria-disabled={page >= totalPages}
            className={page >= totalPages ? "pointer-events-none opacity-30" : "hover:underline"}
          >
            Older →
          </Link>
        </nav>
      )}
    </section>
  );
}
