import { DASHBOARD_GRID, SPAN_STANDARD, SPAN_WIDE } from "./grid.ts";

/**
 * Dashboard loading skeleton (Phase 13, P13-15, ADR-029).
 *
 * `loadDashboard` fans ten queries out in parallel, but the slowest of them
 * (performance over `ALL`, which walks every holding snapshot) still gates the
 * whole page. This skeleton is the `<Suspense>` fallback the dashboard streams
 * first, so the shell paints immediately instead of waiting on the data.
 *
 * It is rendered **inside `page.tsx`'s own `<Suspense>` boundary rather than as
 * `src/app/loading.tsx`** on purpose: a root-segment `loading.tsx` is inherited
 * by every nested route that lacks its own, which would flash a dashboard
 * skeleton on the way to `/accounts`, `/analysis`, and friends. Scoping the
 * boundary to the page keeps the fallback where it belongs.
 *
 * The blocks reuse {@link DASHBOARD_GRID} and its span constants directly, so the
 * real cards land exactly where their placeholders were — the layout can't drift
 * out of sync because both sides read the same values.
 */

/** Shared bar/box styling for a placeholder block. */
const BLOCK = "rounded bg-zinc-100 dark:bg-zinc-800";
const CARD = "rounded-lg border border-zinc-200 p-4 dark:border-zinc-800";

/** One placeholder card: a title bar plus a body block. */
function SkeletonCard({
  className,
  bodyHeight,
}: {
  readonly className: string;
  readonly bodyHeight: string;
}): React.JSX.Element {
  return (
    <div className={`${CARD} ${className}`}>
      <div className={`h-4 w-24 ${BLOCK}`} />
      <div className={`mt-4 w-full ${bodyHeight} ${BLOCK}`} />
    </div>
  );
}

export function DashboardSkeleton(): React.JSX.Element {
  return (
    // The whole tree is decorative; the status text is what a screen reader hears.
    <div className="animate-pulse">
      <span className="sr-only">Loading dashboard…</span>

      {/* Hero: label + big figure */}
      <div aria-hidden className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <div className={`h-7 w-40 ${BLOCK}`} />
          <div className={`h-4 w-32 ${BLOCK}`} />
        </div>
        <div className="space-y-2 sm:flex sm:flex-col sm:items-end">
          <div className={`h-9 w-48 ${BLOCK}`} />
          <div className={`h-4 w-28 ${BLOCK}`} />
        </div>
      </div>

      {/* History chart */}
      <div aria-hidden className={`mt-6 ${CARD}`}>
        <div className="flex items-center justify-between">
          <div className={`h-4 w-16 ${BLOCK}`} />
          <div className={`h-7 w-56 ${BLOCK}`} />
        </div>
        <div className={`mt-3 h-56 w-full ${BLOCK}`} />
      </div>

      {/* Card grid — spans mirror the real layout */}
      <div aria-hidden className={`mt-6 ${DASHBOARD_GRID}`}>
        <SkeletonCard className={SPAN_WIDE} bodyHeight="h-56" />
        <SkeletonCard className={SPAN_WIDE} bodyHeight="h-56" />
        <SkeletonCard className={SPAN_STANDARD} bodyHeight="h-24" />
        <SkeletonCard className={SPAN_STANDARD} bodyHeight="h-24" />
        <SkeletonCard className={SPAN_STANDARD} bodyHeight="h-24" />
        <SkeletonCard className={SPAN_STANDARD} bodyHeight="h-24" />
      </div>

      {/* Accounts table */}
      <div aria-hidden className="mt-8 space-y-3">
        <div className={`h-4 w-20 ${BLOCK}`} />
        <div className={`h-8 w-full ${BLOCK}`} />
        <div className={`h-8 w-full ${BLOCK}`} />
        <div className={`h-8 w-full ${BLOCK}`} />
      </div>
    </div>
  );
}
