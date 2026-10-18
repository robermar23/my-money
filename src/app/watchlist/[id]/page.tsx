import { buttonClass } from "@/components/ui/button-styles.ts";
import { Button } from "@/components/ui/button.tsx";
import { requireUser } from "@/lib/auth/require-user.ts";
import { Money } from "@/lib/money/money.ts";
import { assetClassLabel } from "@/lib/watchlist/display.ts";
import { isLimitedHistory, watchlistItemDetail } from "@/lib/watchlist/queries.ts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PriceHistoryChart } from "../../investments/security/price-history-chart.tsx";
import {
  createPriceTargetAction,
  deletePriceTargetAction,
  deleteWatchlistItemAction,
  togglePriceTargetAction,
} from "../actions.ts";
import { AddTargetForm } from "./add-target-form.tsx";
import { ConfirmButton } from "./confirm-button.tsx";

interface PageProps {
  readonly params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const detail = await watchlistItemDetail(id);
  return { title: detail ? (detail.item.label ?? detail.item.symbol) : "Watchlist" };
}

/** "above" ⇒ rises to/above; "below" ⇒ falls to/below (inclusive, ADR-026). */
function directionLabel(direction: string): string {
  return direction === "below" ? "Falls to / below" : "Rises to / above";
}

export default async function WatchlistDetailPage(props: PageProps): Promise<React.JSX.Element> {
  await requireUser();
  const { id } = await props.params;
  const detail = await watchlistItemDetail(id);
  if (!detail) notFound();

  const { item, latestClose, valuation, targets, priceHistory } = detail;
  const currency = item.currency;
  const gl = valuation.gainLoss.absolute;

  // Chart points — Number() only at this display edge.
  const pricePoints = priceHistory.map((p) => ({ date: p.date, close: Number(p.value) }));
  const limited = isLimitedHistory(priceHistory);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <Link href="/watchlist" className="text-sm text-zinc-500 hover:underline">
        ← Watchlist
      </Link>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-mono font-semibold text-2xl tracking-tight">{item.symbol}</h1>
          <p className="mt-1 text-sm text-zinc-500">{item.label ?? "Watching"}</p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span>{assetClassLabel(item.assetClass)}</span>
            <span>· Not counted in net worth</span>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-3xl tabular-nums">
            {latestClose ? Money.fromString(latestClose, currency).format() : "—"}
          </div>
          <div className="mt-0.5 text-sm text-zinc-500">last close</div>
        </div>
      </div>

      {valuation.costBasis && (
        <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Pretend value" value={valuation.value ? valuation.value.format() : "—"} />
          <Stat label="Cost basis" value={valuation.costBasis.format()} />
          <Stat
            label="Gain/Loss"
            value={gl ? gl.format() : "—"}
            tone={gl ? (gl.isNegative() ? "neg" : "pos") : undefined}
          />
          <Stat
            label="Return"
            value={valuation.gainLoss.percent ? `${valuation.gainLoss.percent}%` : "—"}
            tone={gl ? (gl.isNegative() ? "neg" : "pos") : undefined}
          />
        </section>
      )}

      <section className="mt-8">
        <h2 className="font-medium">Price history</h2>
        <p className="mt-0.5 text-xs text-zinc-400">
          Daily close{item.pretendPurchasedAt ? " since your pretend purchase" : ", last 24 months"}
          .
        </p>
        <div className="mt-3">
          <PriceHistoryChart points={pricePoints} />
        </div>
        {limited && (
          <p className="mt-2 text-xs text-zinc-500">
            Limited history so far — the backfill is best-effort and the nightly price fetch will
            fill it in over time.
          </p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="font-medium">Price targets</h2>
        <p className="mt-0.5 text-xs text-zinc-400">
          One-shot alerts. A target fires once when the daily close crosses it, then pauses — re-arm
          it to watch again. The alert email is content-free; figures show only here and on /alerts.
        </p>

        {targets.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No targets yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs text-zinc-500 uppercase">
                <tr>
                  <th className="py-2 pr-2">When</th>
                  <th className="py-2 pr-2 text-right">Threshold</th>
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2 pr-2">Note</th>
                  <th className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {targets.map((t) => (
                  <tr key={t.id}>
                    <td className="py-2 pr-2">{directionLabel(t.direction)}</td>
                    <td className="py-2 pr-2 text-right font-mono tabular-nums">
                      {Money.fromString(t.threshold, currency).format()}
                    </td>
                    <td className="py-2 pr-2">
                      {t.active ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700 text-xs dark:bg-emerald-950 dark:text-emerald-400">
                          Armed
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-500">
                          {t.triggeredAt
                            ? `Triggered ${t.triggeredAt.toISOString().slice(0, 10)}${
                                t.triggeredPrice
                                  ? ` @ ${Money.fromString(t.triggeredPrice, currency).format()}`
                                  : ""
                              }`
                            : "Paused"}
                        </span>
                      )}
                    </td>
                    <td className="truncate py-2 pr-2 text-zinc-600 dark:text-zinc-400">
                      {t.note ?? "—"}
                    </td>
                    <td className="py-2">
                      <div className="flex items-center justify-end gap-2">
                        <form action={togglePriceTargetAction.bind(null, t.id, item.id)}>
                          <Button type="submit" variant="secondary" size="xs">
                            {t.active ? "Pause" : "Re-arm"}
                          </Button>
                        </form>
                        <ConfirmButton
                          action={deletePriceTargetAction.bind(null, t.id, item.id)}
                          confirmMessage="Delete this price target?"
                          label="Delete"
                          size="xs"
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <AddTargetForm action={createPriceTargetAction.bind(null, item.id)} />
      </section>

      <section className="mt-10 flex flex-wrap items-center justify-between gap-3 border-zinc-100 border-t pt-6 dark:border-zinc-900">
        <Link
          href={`/watchlist/${item.id}/edit`}
          className={buttonClass({ variant: "secondary", size: "md" })}
        >
          Edit
        </Link>
        <ConfirmButton
          action={deleteWatchlistItemAction.bind(null, item.id)}
          confirmMessage={`Stop watching ${item.symbol}? This removes the item and its targets.`}
          label="Delete watchlist item"
        />
      </section>

      <p className="mt-8 text-xs text-zinc-400">
        A watchlist item never counts toward net worth. The pretend gain/loss is a display figure
        only — no realized P&amp;L, tax lots, or 1099 reporting.
      </p>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "pos" | "neg";
}): React.JSX.Element {
  const toneClass =
    tone === "neg"
      ? "text-red-600 dark:text-red-400"
      : tone === "pos"
        ? "text-emerald-600 dark:text-emerald-400"
        : "";
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 font-mono font-semibold text-lg tabular-nums ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}
