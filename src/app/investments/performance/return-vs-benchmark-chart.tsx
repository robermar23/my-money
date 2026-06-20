"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * P9-14 — portfolio vs. benchmark, both indexed to "growth of 100" so they're
 * directly comparable (performance.ts twrIndexSeries, flow-neutralized). Recharts
 * island (ADR-005/013); the server does all the chaining.
 */

interface Point {
  readonly date: string;
  readonly portfolio: number | null;
  readonly benchmark: number | null;
}

interface Props {
  readonly points: readonly Point[];
}

export function ReturnVsBenchmarkChart({ points }: Props): React.JSX.Element {
  if (points.length < 2) {
    return (
      <div className="flex h-72 items-center justify-center rounded-md border border-zinc-200 border-dashed text-sm text-zinc-500 dark:border-zinc-800">
        Not enough history to compare against the benchmark yet.
      </div>
    );
  }

  const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points as Point[]} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
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
            width={48}
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
          <Legend wrapperStyle={{ fontSize: "12px" }} />
          <Line
            type="monotone"
            dataKey="portfolio"
            name="Portfolio"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="benchmark"
            name="S&P 500"
            stroke="#a1a1aa"
            strokeWidth={2}
            strokeDasharray="5 3"
            dot={false}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
