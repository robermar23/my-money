"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * P9-14 — contributions vs. market growth over the range (performance.ts
 * attribution). Answers "did my portfolio grow, or did I just add money?" Two
 * signed bars: what you contributed vs. what the market did. Recharts island.
 */

interface Props {
  readonly netFlows: number;
  readonly marketGrowth: number;
  readonly currency: string;
}

export function AttributionChart({ netFlows, marketGrowth, currency }: Props): React.JSX.Element {
  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });

  const data = [
    { label: "Net contributions", amount: netFlows },
    { label: "Market growth", amount: marketGrowth },
  ];
  const color = (v: number): string => (v < 0 ? "#ef4444" : "#10b981");

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis
            dataKey="label"
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
            cursor={{ fill: "currentColor", fillOpacity: 0.05 }}
            contentStyle={{
              backgroundColor: "rgb(24 24 27)",
              border: "1px solid rgb(63 63 70)",
              borderRadius: "6px",
              fontSize: "12px",
              color: "rgb(244 244 245)",
            }}
            formatter={(value) => [fmt.format(Number(value)), "Amount"]}
          />
          <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
            {data.map((d) => (
              <Cell key={d.label} fill={color(d.amount)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
