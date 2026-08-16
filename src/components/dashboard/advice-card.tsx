import { GuidanceDisclaimer } from "@/components/guidance-disclaimer.tsx";
import type { AdviceCard as AdviceCardData } from "@/lib/dashboard/loader.ts";
import { Money } from "@/lib/money/money.ts";
import { DashboardCard } from "./card.tsx";

/**
 * Household-guidance card (Phase 15, P15-35, ADR-032/ADR-029).
 *
 * One recommendation and the current waterfall rung. Like every card here it
 * does no math and makes no decisions — `loadDashboard` picked the top item off
 * the engine's already-sorted list, so this card and the first row of `/plan` are
 * the same item by construction (ADR-029 §2).
 *
 * ── Why one item and not three ─────────────────────────────────────────────
 * The dashboard's currency is attention. Three recommendations on a card that
 * cannot show their rationale, their heuristic, or the inputs behind them is
 * three unexplained instructions — the opposite of what ADR-032 §2 asks for. One
 * item with its "why", plus a count and a link, sends the user to the page that
 * can actually justify itself.
 *
 * ── The compact disclaimer is not optional ─────────────────────────────────
 * ADR-032 §5 requires the banner on **every** advice surface, and a dashboard
 * card is an advice surface. It renders in all three states, including the calm
 * one — a user who reads "you are on track" has been given guidance just as much
 * as one who reads "pay this down".
 */

interface Props {
  /** Undefined only if the loader is ever called without the guidance read. */
  readonly data?: AdviceCardData;
  readonly className?: string;
  readonly currency?: string;
}

const CARD_TITLE = "Your plan";
const DEEP_LINK = "/plan";

const SEVERITY_BADGE: Readonly<Record<string, string>> = {
  critical: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  info: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
};

/** One line naming the rung in play, or nothing when the ladder is finished. */
function FocusLine({
  focus,
}: {
  readonly focus: { readonly label: string } | null;
}): React.JSX.Element {
  return (
    <p className="mt-3 border-zinc-100 border-t pt-2 text-xs text-zinc-500 dark:border-zinc-900">
      {focus ? `Next dollar goes to: ${focus.label}` : "Every rung the app can verify is complete."}
    </p>
  );
}

export function AdviceCard({ data, className, currency = "USD" }: Props): React.JSX.Element | null {
  if (data === undefined) return null;

  if (data.status === "empty") {
    return (
      <DashboardCard title={CARD_TITLE} href={DEEP_LINK} linkLabel="Plan →" className={className}>
        <DashboardCard.Empty message={data.reason} href={data.href} linkLabel="Fix this" />
        <GuidanceDisclaimer variant="compact" />
      </DashboardCard>
    );
  }

  if (data.status === "clear") {
    return (
      <DashboardCard title={CARD_TITLE} href={DEEP_LINK} linkLabel="Plan →" className={className}>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Nothing needs your attention right now.
        </p>
        <FocusLine focus={data.focus} />
        <GuidanceDisclaimer variant="compact" />
      </DashboardCard>
    );
  }

  const { top } = data;
  const more = data.total - 1;

  return (
    <DashboardCard title={CARD_TITLE} href={DEEP_LINK} linkLabel="Plan →" className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 font-medium text-xs ${
            SEVERITY_BADGE[top.severity] ?? SEVERITY_BADGE.info
          }`}
        >
          {top.severity}
        </span>
        {top.status === "unknown_input" && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 text-xs dark:bg-amber-950 dark:text-amber-300">
            missing an input
          </span>
        )}
      </div>

      <p className="mt-2 font-medium text-sm">{top.title}</p>
      <p className="mt-1 text-xs text-zinc-500">{top.rationale}</p>

      {top.impact !== null && (
        <div className="mt-2">
          <div className="text-xs text-zinc-500">Gap</div>
          <div className="font-mono text-lg tabular-nums">
            {Money.fromString(top.impact, currency).format()}
          </div>
        </div>
      )}

      {more > 0 && (
        <p className="mt-2 text-xs text-zinc-500">
          {more} more {more === 1 ? "item" : "items"} on your plan.
        </p>
      )}

      <FocusLine focus={data.focus} />
      <GuidanceDisclaimer variant="compact" />
    </DashboardCard>
  );
}
