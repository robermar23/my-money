import { requireUser } from "@/lib/auth/require-user.ts";
import { watchlistItemDetail } from "@/lib/watchlist/queries.ts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { updateWatchlistItemAction } from "../../actions.ts";
import { WatchlistItemForm } from "../../watchlist-item-form.tsx";

interface PageProps {
  readonly params: Promise<{ id: string }>;
}

export const metadata: Metadata = { title: "Edit watchlist item" };

export default async function EditWatchlistItemPage(props: PageProps): Promise<React.JSX.Element> {
  await requireUser();
  const { id } = await props.params;
  const detail = await watchlistItemDetail(id);
  if (!detail) notFound();

  const { item } = detail;
  // Bind the id so the form's action keeps the `(prev, formData)` shape.
  const action = updateWatchlistItemAction.bind(null, id);

  return (
    <main className="mx-auto max-w-xl p-6">
      <Link href={`/watchlist/${id}`} className="text-sm text-zinc-500 hover:underline">
        ← {item.symbol}
      </Link>
      <h1 className="mt-2 font-semibold text-2xl tracking-tight">Edit {item.symbol}</h1>
      <div className="mt-6">
        <WatchlistItemForm
          action={action}
          submitLabel="Save changes"
          defaults={{
            symbol: item.symbol,
            assetClass: item.assetClass,
            label: item.label,
            pretendQuantity: item.pretendQuantity,
            pretendUnitCost: item.pretendUnitCost,
            pretendPurchasedAt: item.pretendPurchasedAt,
            currency: item.currency,
            notes: item.notes,
          }}
        />
      </div>
    </main>
  );
}
