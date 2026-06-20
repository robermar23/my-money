"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/**
 * P9-21 — Received-income growth by year. Recharts Client Component island; the
 * server aggregates actual dividend/interest received (forward-income.ts →
 * incomeGrowth), so these are *actuals*, not a projection. Number() at this edge.
 */

interface Point {
  readonly year: string;
  readonly income: number;
}

interface Props {
  readonly points: readonly Point[];
  readonly currency: string;
}

export function IncomeGrowthChart({ points, currency }: Props): React.JSX.Element {
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
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points as Point[]} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis
            dataKey="year"
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
            width={70}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "rgb(24 24 27)",
              border: "1px solid rgb(63 63 70)",
              borderRadius: "6px",
              fontSize: "12px",
              color: "rgb(244 244 245)",
            }}
            formatter={(value) => [fmt.format(Number(value)), "Income"]}
          />
          <Bar dataKey="income" name="Income" fill="#3b82f6" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
