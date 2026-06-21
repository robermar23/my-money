"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Point {
  readonly date: string;
  readonly value: string;
}

interface Props {
  readonly points: readonly Point[];
  readonly currency: string;
}

/**
 * Value-over-time chart for a personal asset (Phase 10, P10-14). Copies the
 * net-worth-chart island pattern (ADR-005): Recharts in a Client Component,
 * `Number()` only at the display edge, dark-mode `currentColor`. The snapshot
 * history table already covers the requirement; this is the nice-to-have. Needs
 * ≥2 points to draw a line — falls back to a hint otherwise.
 */
export function AssetValueChart({ points, currency }: Props): React.JSX.Element {
  if (points.length < 2) {
    return (
      <div className="flex h-56 items-center justify-center rounded-md border border-zinc-200 border-dashed text-sm text-zinc-500 dark:border-zinc-800">
        Record at least two valuations to see the value trend.
      </div>
    );
  }

  // Recharts wants numbers; we accept the precision loss at the display layer.
  const data = points.map((p) => ({ date: p.date, value: Number(p.value) }));

  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis
            dataKey="date"
            stroke="currentColor"
            tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.6 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            stroke="currentColor"
            tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.6 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => fmt.format(v)}
            width={80}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "rgb(24 24 27)",
              border: "1px solid rgb(63 63 70)",
              borderRadius: "6px",
              fontSize: "12px",
              color: "rgb(244 244 245)",
            }}
            formatter={(value) => [fmt.format(Number(value)), "Value"]}
          />
          <Line type="monotone" dataKey="value" stroke="currentColor" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
