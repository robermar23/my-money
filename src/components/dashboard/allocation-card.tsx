import { AllocationChart } from "@/app/investments/allocation-chart.tsx";
import type { AllocationCard as AllocationCardData } from "@/lib/dashboard/loader.ts";
import { DashboardCard } from "./card.tsx";

/**
 * Allocation card (Phase 13, P13-07, ADR-029).
 *
 * Renders the existing {@link AllocationChart} island (donut + legend, reused
 * verbatim — ADR-029 §4) with `allocationByAssetClass` slices from the loader.
 * Pure presentation: it only maps the loader's {@link Money} slices to the
 * island's display shape (`Number()` at this edge only, per §Money & Precision)
 * and links out to `/investments`. Degraded state when there are no valued
 * holdings (ADR-029 §5).
 */

interface Props {
  readonly data: AllocationCardData;
}

export function AllocationCard({ data }: Props): React.JSX.Element {
  if (data.status === "empty") {
    return (
      <DashboardCard title="Allocation" href="/investments" linkLabel="Investments →">
        <DashboardCard.Empty
          message="No priced holdings yet."
          href="/investments"
          linkLabel="Add an investment"
        />
      </DashboardCard>
    );
  }

  const slices = data.slices.map((s) => ({
    label: s.label,
    // Recharts wants a number for the arc size; precision loss is display-only.
    value: Number(s.value.toString()),
    percent: s.percent,
    valueFormatted: s.value.format(),
  }));

  return (
    <DashboardCard title="Allocation" href="/investments" linkLabel="Investments →">
      <p className="mb-3 font-mono text-xl tabular-nums">{data.total.format()}</p>
      <AllocationChart slices={slices} />
    </DashboardCard>
  );
}
