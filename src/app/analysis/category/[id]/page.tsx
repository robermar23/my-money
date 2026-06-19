import { resolveRange } from "@/lib/analytics/range.ts";
import { categoryDetail } from "@/lib/analytics/spending.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { Money } from "@/lib/money/money.ts";
import { listTransactionsForCategory } from "@/lib/transactions/queries.ts";
import type { Metadata } from "next";
import Link from "next/link";
import { CategoryTrendChart } from "../../category-trend-chart.tsx";

export const metadata: Metadata = { title: "Category detail" };

const CURRENCY = "USD";
const UUID_RE = /^[0-9a-f-]{36}$/i;

interface PageProps {
  readonly params: Promise<{ id: string }>;
  readonly searchParams?: Promise<{
    range?: string;
    from?: string;
    to?: string;
    account?: string;
    page?: string;
  }>;
}

export default async function CategoryDetailPage(props: PageProps): Promise<React.JSX.Element> {
  await requireUser();
  const { id } = await props.params;
  const search = (await props.searchParams) ?? {};
  const range = resolveRange(search);
  const accountId = search.account && UUID_RE.test(search.account) ? search.account : null;
  const accountIds = accountId ? [accountId] : undefined;
  const page = Math.max(1, Number.parseInt(search.page ?? "1", 10) || 1);

  const [detail, txns] = await Promise.all([
    categoryDetail(id, { from: range.from, to: range.to }, accountIds),
    listTransactionsForCategory({
      categoryId: id,
      from: range.from,
      to: range.to,
      accountIds,
      page,
    }),
  ]);

  // Preserve range/account on the back link and pagination.
  const carry = new URLSearchParams();
  if (search.range) carry.set("range", search.range);
  if (search.from) carry.set("from", search.from);
  if (search.to) carry.set("to", search.to);
  if (accountId) carry.set("account", accountId);
  const backHref = `/analysis${carry.toString() ? `?${carry.toString()}` : ""}`;
  const pageHref = (p: number): string => {
    const sp = new URLSearchParams(carry.toString());
    sp.set("page", String(p));
    return `/analysis/category/${id}?${sp.toString()}`;
  };

  if (!detail.category) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <Link href={backHref} className="text-sm text-zinc-500 hover:underline">
          ← Analysis
        </Link>
        <p className="mt-8 text-sm text-zinc-500">Category not found.</p>
      </main>
    );
  }

  const points = detail.monthly.map((m) => ({ month: m.month, total: Number(m.total) }));

  return (
    <main className="mx-auto max-w-3xl p-6">
      <Link href={backHref} className="text-sm text-zinc-500 hover:underline">
        ← Analysis
      </Link>
      <div className="mt-2 flex items-baseline justify-between">
        <h1 className="font-semibold text-2xl tracking-tight">{detail.category.name}</h1>
        <span className="font-mono text-lg tabular-nums">
          {Money.fromString(detail.total, CURRENCY).format()}
        </span>
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        {detail.category.groupName ?? "Ungrouped"} · {detail.category.kind} · {range.label}
      </p>

      <section className="mt-6">
        <CategoryTrendChart points={points} currency={CURRENCY} />
      </section>

      <section className="mt-8">
        <h2 className="font-medium">
          Transactions <span className="text-sm text-zinc-500">({txns.totalCount})</span>
        </h2>
        {txns.rows.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No transactions in this range.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs text-zinc-500 uppercase">
              <tr>
                <th className="py-2">Date</th>
                <th className="py-2">Name</th>
                <th className="py-2">Account</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {txns.rows.map((t) => (
                <tr key={t.id}>
                  <td className="py-2 text-zinc-500">{t.postedAt}</td>
                  <td className="py-2">{t.name}</td>
                  <td className="py-2 text-zinc-500">{t.accountName}</td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {Money.fromString(t.amount, CURRENCY).format()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {txns.totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between text-sm">
            {page > 1 ? (
              <Link href={pageHref(page - 1)} className="text-zinc-500 hover:underline">
                ← Previous
              </Link>
            ) : (
              <span />
            )}
            <span className="text-zinc-500">
              Page {page} of {txns.totalPages}
            </span>
            {page < txns.totalPages ? (
              <Link href={pageHref(page + 1)} className="text-zinc-500 hover:underline">
                Next →
              </Link>
            ) : (
              <span />
            )}
          </div>
        )}
      </section>
    </main>
  );
}
