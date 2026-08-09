import Link from "next/link";

/**
 * Shared dashboard card frame (Phase 13, P13-04, ADR-029).
 *
 * The curated dashboard is a grid of these frames. A card is a **server
 * component and pure presentation** — it receives already-computed, typed data
 * from `loadDashboard` and only formats + links (ADR-029 §2: cards are dumb, the
 * loader is smart). The frame gives every card the same chrome (title, optional
 * "→ deep page" link, body slot) so the grid reads consistently, and
 * {@link DashboardCard.Empty} renders the graceful degraded state (ADR-029 §5).
 */

interface DashboardCardProps {
  /** Card heading. */
  readonly title: string;
  /** Optional deep link to the page that owns this data (read-only navigate-out). */
  readonly href?: string;
  /** Label for the deep link; defaults to "View →". */
  readonly linkLabel?: string;
  /** Card body. */
  readonly children: React.ReactNode;
  /** Extra classes for the outer section (e.g. grid column spans). */
  readonly className?: string;
}

/** The card chrome: bordered panel with a title row and a body slot. */
export function DashboardCard({
  title,
  href,
  linkLabel = "View →",
  children,
  className,
}: DashboardCardProps): React.JSX.Element {
  return (
    <section
      className={`rounded-lg border border-zinc-200 p-4 dark:border-zinc-800${
        className ? ` ${className}` : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium text-sm">{title}</h2>
        {href ? (
          <Link href={href} className="shrink-0 text-xs text-zinc-500 hover:underline">
            {linkLabel}
          </Link>
        ) : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

interface EmptyProps {
  /** The reason/nudge shown in the degraded state. */
  readonly message: string;
  /** Optional call-to-action link (e.g. "Add an investment"). */
  readonly href?: string;
  /** CTA label; defaults to the message when a link is given without one. */
  readonly linkLabel?: string;
}

/**
 * Degraded-state body: a calm, dashed placeholder with an optional call to
 * action. Used when a card's inputs are absent/insufficient (ADR-029 §5) — the
 * dashboard never errors because one feature is unused.
 */
DashboardCard.Empty = function DashboardCardEmpty({
  message,
  href,
  linkLabel,
}: EmptyProps): React.JSX.Element {
  return (
    <div className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-md border border-zinc-200 border-dashed p-4 text-center text-sm text-zinc-500 dark:border-zinc-800">
      <p>{message}</p>
      {href ? (
        <Link href={href} className="underline">
          {linkLabel ?? "Get started"} →
        </Link>
      ) : null}
    </div>
  );
};
