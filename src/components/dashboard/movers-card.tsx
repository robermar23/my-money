import type { Mover, MoversCard as MoversCardData } from "@/lib/dashboard/loader.ts";
import { DashboardCard } from "./card.tsx";

/**
 * Watchlist-movers card (Phase 13, P13-12, ADR-029).
 *
 * The biggest gainers and losers among the watchlist's *paper* positions, valued
 * by the Phase 11 `paperValuation` the loader already ran (ADR-029 §4: no new
 * compute). Links to `/watchlist`, which owns the rows and their price targets.
 *
 * **These are pretend positions** (ADR-025): they never touch net worth and are
 * never realized P&L. The card labels them so a green number here is never
 * mistaken for money the user actually made.
 */

interface Props {
  readonly data: MoversCardData;
  /** Grid column span assigned by the dashboard layout (P13-14). */
  readonly className?: string;
}

const CARD_TITLE = "Watchlist movers";
const DEEP_LINK = "/watchlist";

/** Row tone + arrow for a signed percent string (money math happened upstream). */
function toneFor(percent: string): { readonly className: string; readonly arrow: string } {
  // Sign inspection only — the percent is already a formatted display ratio.
  if (percent.startsWith("-")) {
    return { className: "text-red-600 dark:text-red-400", arrow: "▼" };
  }
  if (Number(percent) === 0) {
    return { className: "text-zinc-500", arrow: "—" };
  }
  return { className: "text-emerald-600 dark:text-emerald-400", arrow: "▲" };
}

/** One mover: symbol (+ optional label) against its paper gain/loss. */
function MoverRow({ mover }: { readonly mover: Mover }): React.JSX.Element {
  const { className, arrow } = toneFor(mover.percent);
  // Strip the sign from the magnitude — the arrow already carries direction.
  const magnitude = mover.gain.isNegative() ? mover.gain.negate() : mover.gain;

  return (
    <li className="flex items-baseline justify-between gap-2">
      <span className="min-w-0 truncate">
        <span className="font-medium">{mover.symbol}</span>
        {mover.label ? <span className="ml-2 text-xs text-zinc-500">{mover.label}</span> : null}
      </span>
      <span className={`shrink-0 font-mono text-sm tabular-nums ${className}`}>
        {arrow} {mover.percent.replace("-", "")}%
        <span className="ml-2 text-xs text-zinc-500">{magnitude.format()}</span>
      </span>
    </li>
  );
}

export function MoversCard({ data, className }: Props): React.JSX.Element {
  if (data.status === "empty") {
    return (
      <DashboardCard
        title={CARD_TITLE}
        href={DEEP_LINK}
        linkLabel="Watchlist →"
        className={className}
      >
        <DashboardCard.Empty
          message="No paper positions to track yet."
          href={DEEP_LINK}
          linkLabel="Watch a symbol"
        />
      </DashboardCard>
    );
  }

  return (
    <DashboardCard
      title={CARD_TITLE}
      href={DEEP_LINK}
      linkLabel="Watchlist →"
      className={className}
    >
      <ul className="space-y-1.5 text-sm">
        {data.movers.map((mover) => (
          <MoverRow key={mover.id} mover={mover} />
        ))}
      </ul>
      {/* ADR-025: pretend positions, outside net worth. */}
      <p className="mt-3 text-xs text-zinc-400">Pretend positions — not counted in net worth.</p>
    </DashboardCard>
  );
}
