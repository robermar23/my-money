import { requireUser } from "@/lib/auth/require-user.ts";
import type { Metadata } from "next";
import Link from "next/link";
import { createWatchlistItemAction } from "../actions.ts";
import { WatchlistItemForm } from "../watchlist-item-form.tsx";

export const metadata: Metadata = { title: "Add to watchlist" };

export default async function NewWatchlistItemPage(): Promise<React.JSX.Element> {
  await requireUser();
  return (
    <main className="mx-auto max-w-xl p-6">
      <Link href="/watchlist" className="text-sm text-zinc-500 hover:underline">
        ← Watchlist
      </Link>
      <h1 className="mt-2 font-semibold text-2xl tracking-tight">Add to watchlist</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Follow a stock, ETF, metal, or crypto. Add an optional pretend buy to track a hypothetical
        gain/loss, then set price-target alerts on its detail page.
      </p>
      <div className="mt-6">
        <WatchlistItemForm action={createWatchlistItemAction} submitLabel="Add symbol" />
      </div>
    </main>
  );
}
