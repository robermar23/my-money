"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/**
 * P9-17 — Per-security price-history sparkline (resolves the Phase 5 Open Item).
 * Recharts Client Component island; the server passes display-ready closes
 * (Number() at this edge only). Renders the close line over the available range.
 */

interface Point {
  readonly date: string;
  readonly close: number;
}

interface Props {
  readonly points: readonly Point[];
}

export function PriceHistoryChart({ points }: Props): React.JSX.Element {
  if (points.length < 2) {
    return (
      <div className="flex h-48 items-center justify-center rounded-md border border-zinc-200 border-dashed text-sm text-zinc-500 dark:border-zinc-800">
        No price history yet.
      </div>
    );
  }

  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });

  return (
    <div className="h-48 w-full text-blue-600 dark:text-blue-400">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points as Point[]} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.25} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date"
            stroke="currentColor"
            tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.6 }}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
          />
          <YAxis
            stroke="currentColor"
            tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.6 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => fmt.format(v)}
            width={70}
            domain={["auto", "auto"]}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "rgb(24 24 27)",
              border: "1px solid rgb(63 63 70)",
              borderRadius: "6px",
              fontSize: "12px",
              color: "rgb(244 244 245)",
            }}
            formatter={(value) => [fmt.format(Number(value)), "Close"]}
          />
          <Area
            type="monotone"
            dataKey="close"
            stroke="currentColor"
            strokeWidth={2}
            fill="url(#price-fill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
