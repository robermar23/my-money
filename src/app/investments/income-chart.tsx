"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * P5-23 — Dividend / interest income by period. Recharts Client Component
 * island; the server aggregates (src/lib/investments/income.ts) and the period
 * toggle is URL-driven (server-computed), so no client state lives here.
 */

interface Point {
  readonly period: string;
  readonly dividend: number;
  readonly interest: number;
}

interface Props {
  readonly points: readonly Point[];
  readonly currency: string;
}

export function IncomeChart({ points, currency }: Props): React.JSX.Element {
  if (points.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center rounded-md border border-zinc-200 border-dashed text-sm text-zinc-500 dark:border-zinc-800">
        No dividend or interest income recorded yet.
      </div>
    );
  }

  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points as Point[]} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis
            dataKey="period"
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
            formatter={(value: number, name: string) => [fmt.format(value), name]}
          />
          <Legend wrapperStyle={{ fontSize: "12px" }} />
          <Bar dataKey="dividend" name="Dividend" stackId="i" fill="#3b82f6" />
          <Bar dataKey="interest" name="Interest" stackId="i" fill="#10b981" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
