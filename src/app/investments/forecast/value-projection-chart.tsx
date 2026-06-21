"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * P9-21 — Value-projection chart (ADR-022). The whole line is a *projection* of
 * a single user-chosen growth assumption, so it renders dashed end-to-end — it
 * is explicitly an illustrative estimate, not actuals or advice. The server does
 * all the Decimal compounding (projection.ts); Number() lives only at this edge.
 */

interface Point {
  /** Whole years from today. */
  readonly year: number;
  readonly value: number;
}

interface Props {
  readonly points: readonly Point[];
  readonly currency: string;
  /** Optional goal target — drawn as a horizontal reference line. */
  readonly target?: number | null;
  /** Optional label for the goal line (e.g. the projected date). */
  readonly goalLabel?: string | null;
}

export function ValueProjectionChart({
  points,
  currency,
  target = null,
  goalLabel = null,
}: Props): React.JSX.Element {
  if (points.length < 2) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border border-zinc-200 border-dashed text-sm text-zinc-500 dark:border-zinc-800">
        Add a holding to project portfolio value.
      </div>
    );
  }

  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });

  return (
    <div className="h-64 w-full text-violet-600 dark:text-violet-400">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points as Point[]} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="projection-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.2} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis
            dataKey="year"
            stroke="currentColor"
            tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.6 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `+${v}y`}
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
            formatter={(value) => [fmt.format(Number(value)), "Projected"]}
            labelFormatter={(label) => `+${label} years`}
          />
          {target !== null && (
            <ReferenceLine
              y={target}
              stroke="#10b981"
              strokeDasharray="2 2"
              label={{
                value: goalLabel ? `Goal · ${goalLabel}` : "Goal",
                position: "insideTopRight",
                fontSize: 11,
                fill: "#10b981",
              }}
            />
          )}
          <Area
            type="monotone"
            dataKey="value"
            stroke="currentColor"
            strokeWidth={2}
            strokeDasharray="5 4"
            fill="url(#projection-fill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
