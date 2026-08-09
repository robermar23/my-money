import { SearchInput } from "@/components/search-input.tsx";
import { requireUser } from "@/lib/auth/require-user.ts";
import { Money } from "@/lib/money/money.ts";
import { assetClassLabel } from "@/lib/watchlist/display.ts";
import { listWatchlist } from "@/lib/watchlist/queries.ts";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Watchlist" };

interface WatchlistPageProps {
  readonly searchParams?: Promise<{ q?: string }>;
}

/**
 * P11-15 — the `/watchlist` list page. Symbols the user FOLLOWS but does not own;
 * structurally excluded from net worth (ADR-025). Mirrors the /investments table
 * tokens. `Number()` never appears here — money goes through `Money.format()`.
 *
 * P12-17 — an optional `?q=` trigram filter narrows the list by symbol/label/notes.
 */
export default async function WatchlistPage(props: WatchlistPageProps): Promise<React.JSX.Element> {
  await requireUser();
  const search = (await props.searchParams) ?? {};
  const query = search.q?.trim() ?? "";
  const rows = await listWatchlist({ q: query });

  return (
    <main className="mx-auto max-w-5xl p-6">
      <Link href="/" className="text-sm text-zinc-500 hover:underline">
        ← Dashboard
      </Link>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">Watchlist</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Symbols you follow — with an optional "pretend" buy and price-target alerts. These never
            count toward net worth.
          </p>
        </div>
        <Link
          href="/watchlist/new"
          className="rounded-md bg-zinc-900 px-4 py-2 font-medium text-sm text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Add symbol
        </Link>
      </div>

      {(query !== "" || rows.length > 0) && (
        <div className="mt-6">
          <SearchInput
            placeholder="Filter by symbol or name…"
            label="Filter watchlist"
            className="max-w-sm"
          />
        </div>
      )}

      {rows.length === 0 ? (
        query !== "" ? (
          <p className="mt-6 text-sm text-zinc-500">
            No watched symbols match “{query}”.{" "}
            <Link href="/watchlist" className="hover:underline">
              Clear filter
            </Link>
          </p>
        ) : (
          <p className="mt-8 rounded-md border border-zinc-200 border-dashed p-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
            You're not watching anything yet.{" "}
            <Link href="/watchlist/new" className="underline">
              Add a symbol
            </Link>{" "}
            to follow its price and set target alerts.
          </p>
        )
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="text-left text-xs text-zinc-500 uppercase">
              <tr>
                <th className="py-2 pr-2">Symbol</th>
                <th className="py-2 pr-2">Type</th>
                <th className="py-2 pr-2 text-right">Last price</th>
                <th className="py-2 pr-2 text-right">Pretend value</th>
                <th className="py-2 pr-2 text-right">Gain/Loss</th>
                <th className="py-2 text-right">Targets</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {rows.map((r) => {
                const gl = r.valuation.gainLoss.absolute;
                return (
                  <tr key={r.id}>
                    <td className="py-2 pr-2 font-mono">
                      <Link href={`/watchlist/${r.id}`} className="hover:underline">
                        {r.symbol}
                      </Link>
                      {r.label && <span className="ml-2 text-xs text-zinc-500">{r.label}</span>}
                    </td>
                    <td className="py-2 pr-2 text-zinc-600 dark:text-zinc-400">
                      {assetClassLabel(r.assetClass)}
                    </td>
                    <td className="py-2 pr-2 text-right font-mono tabular-nums">
                      {r.latestClose ? Money.fromString(r.latestClose, r.currency).format() : "—"}
                    </td>
                    <td className="py-2 pr-2 text-right font-mono tabular-nums">
                      {r.valuation.value ? r.valuation.value.format() : "—"}
                    </td>
                    <td
                      className={`whitespace-nowrap py-2 pr-2 text-right font-mono tabular-nums ${
                        gl
                          ? gl.isNegative()
                            ? "text-red-600 dark:text-red-400"
                            : "text-emerald-600 dark:text-emerald-400"
                          : ""
                      }`}
                    >
                      {gl ? `${gl.format()} (${r.valuation.gainLoss.percent}%)` : "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {r.activeTargetCount > 0 ? (
                        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-zinc-200 px-1.5 py-0.5 text-xs dark:bg-zinc-800">
                          {r.activeTargetCount}
                        </span>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
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
