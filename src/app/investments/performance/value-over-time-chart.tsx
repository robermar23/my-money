"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * P9-14 — portfolio value over time with a cost-basis overlay. Recharts island
 * (ADR-005/013): the server aggregates from `holding_snapshots` (performance.ts
 * valueSeries / gainLossSeries); this island only renders. The shaded area is
 * value; the dashed line is cost basis, so the gap reads as unrealized gain/loss.
 */

interface Point {
  readonly date: string;
  readonly value: number;
  /** Resolved cost basis on the date, or null when unknown (renders no point). */
  readonly costBasis: number | null;
}

interface Props {
  readonly points: readonly Point[];
  readonly currency: string;
}

export function ValueOverTimeChart({ points, currency }: Props): React.JSX.Element {
  if (points.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded-md border border-zinc-200 border-dashed text-sm text-zinc-500 dark:border-zinc-800">
        Not enough history yet. Value-over-time fills in once daily snapshots accumulate.
      </div>
    );
  }

  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points as Point[]} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
            </linearGradient>
          </defs>
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
            formatter={(value, name) => [fmt.format(Number(value)), String(name)]}
          />
          <Area
            type="monotone"
            dataKey="value"
            name="Value"
            stroke="#3b82f6"
            strokeWidth={2}
            fill="url(#valueFill)"
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="costBasis"
            name="Cost basis"
            stroke="currentColor"
            strokeOpacity={0.5}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
