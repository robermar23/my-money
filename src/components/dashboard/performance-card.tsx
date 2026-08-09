import { ValueOverTimeChart } from "@/app/investments/performance/value-over-time-chart.tsx";
import type { PerformanceCard as PerformanceCardData } from "@/lib/dashboard/loader.ts";
import { DashboardCard } from "./card.tsx";

/**
 * Performance card (Phase 13, P13-08, ADR-029).
 *
 * Shows the time-weighted return for the active range, the delta vs. the S&P 500
 * benchmark, and a compact value-over-time chart — reusing the performance
 * {@link ValueOverTimeChart} island verbatim (ADR-029 §4). **Honors ADR-021**:
 * when the range has < 2 snapshot days the loader returns `insufficient`, so the
 * card renders "insufficient history" rather than a fabricated %. Pure
 * presentation; every figure is computed upstream by `performance.ts`.
 */

interface Props {
  readonly data: PerformanceCardData;
  readonly currency: string;
  /** Grid column span assigned by the dashboard layout (P13-14). */
  readonly className?: string;
}

const CARD_TITLE = "Performance";
const DEEP_LINK = "/investments/performance";

/** Tailwind text color for a signed percent/point figure (green up, red down). */
function toneFor(value: number): string {
  if (value > 0) return "text-emerald-600 dark:text-emerald-400";
  if (value < 0) return "text-red-600 dark:text-red-400";
  return "text-zinc-500";
}

export function PerformanceCard({ data, currency, className }: Props): React.JSX.Element {
  if (data.status === "empty") {
    return (
      <DashboardCard
        title={CARD_TITLE}
        href={DEEP_LINK}
        linkLabel="Performance →"
        className={className}
      >
        <DashboardCard.Empty
          message="No investments to measure yet."
          href="/investments"
          linkLabel="Add an investment"
        />
      </DashboardCard>
    );
  }

  if (data.status === "insufficient") {
    return (
      <DashboardCard
        title={CARD_TITLE}
        href={DEEP_LINK}
        linkLabel="Performance →"
        className={className}
      >
        <DashboardCard.Empty message="Insufficient history for this range." />
      </DashboardCard>
    );
  }

  const twrNum = data.twr === null ? null : Number(data.twr);
  const benchDeltaNum = data.benchmarkDelta === null ? null : Number(data.benchmarkDelta);

  // gainLossSeries → the value-over-time island's {date, value, costBasis} shape.
  // Number() at this display edge only (§Money & Numeric Precision).
  const points = data.gainLoss.map((p) => ({
    date: p.date,
    value: Number(p.value),
    costBasis: p.costBasis === null ? null : Number(p.costBasis),
  }));

  return (
    <DashboardCard
      title={CARD_TITLE}
      href={DEEP_LINK}
      linkLabel="Performance →"
      className={className}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-xs text-zinc-500">Return (range)</div>
          <div
            className={`font-mono text-2xl tabular-nums ${twrNum === null ? "text-zinc-500" : toneFor(twrNum)}`}
          >
            {twrNum === null ? "—" : `${twrNum > 0 ? "+" : ""}${data.twr}%`}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-zinc-500">vs. S&amp;P 500</div>
          <div
            className={`font-mono text-sm tabular-nums ${
              benchDeltaNum === null ? "text-zinc-500" : toneFor(benchDeltaNum)
            }`}
          >
            {benchDeltaNum === null
              ? "—"
              : `${benchDeltaNum > 0 ? "+" : ""}${data.benchmarkDelta} pts`}
          </div>
        </div>
      </div>
      <div className="mt-3">
        <ValueOverTimeChart points={points} currency={currency} />
      </div>
    </DashboardCard>
  );
}
