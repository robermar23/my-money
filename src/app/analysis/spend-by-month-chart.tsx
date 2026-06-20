"use client";

import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { colorForIndex } from "./chart-colors.ts";

/**
 * P8-14 — Spend-by-month chart (ADR-005). Stacked bars of expense spend per
 * category with a net (income − expense) line overlaid. Client island; the
 * server passes display-ready numbers (the single `Number()` happens upstream).
 *
 * P8-22 — The trailing rows may be a *forecast* (`projectedCount`): those bars
 * render dimmed and the net line continues as a dashed segment, so projections
 * read clearly as estimates rather than recorded spend.
 */
interface SeriesCategory {
  readonly id: string;
  readonly name: string;
}

/** One month row: `{ month, net, [categoryId]: spend }` (numbers for Recharts). */
type MonthRow = { month: string; net: number } & Record<string, number | string>;

interface Props {
  readonly data: readonly MonthRow[];
  readonly categories: readonly SeriesCategory[];
  readonly currency: string;
  /** Count of trailing rows that are projections (default 0 = all actual). */
  readonly projectedCount?: number;
}

/** A render row carrying the net split into solid (actual) + dashed (projected). */
type RenderRow = {
  month: string;
  net: number;
  netSolid: number | null;
  netDashed: number | null;
  [key: string]: number | string | null;
};

export function SpendByMonthChart({
  data,
  categories,
  currency,
  projectedCount = 0,
}: Props): React.JSX.Element {
  if (data.length === 0 || categories.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded-md border border-zinc-200 border-dashed text-sm text-zinc-500 dark:border-zinc-800">
        No categorized spending to chart in this range.
      </div>
    );
  }

  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });

  // Index of the first projected row (= data.length when nothing is projected).
  const firstProjected = data.length - Math.max(0, projectedCount);

  // Split the net line so the actual span draws solid and the projected tail
  // draws dashed, with the last actual point shared as a connector.
  const rows: RenderRow[] = data.map((row, i) => {
    const isProjected = i >= firstProjected;
    return {
      ...row,
      netSolid: isProjected ? null : row.net,
      netDashed: isProjected || i === firstProjected - 1 ? row.net : null,
    };
  });

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis
            dataKey="month"
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
          <Legend wrapperStyle={{ fontSize: "11px" }} />
          {categories.map((c, i) => (
            <Bar key={c.id} dataKey={c.id} name={c.name} stackId="spend" fill={colorForIndex(i)}>
              {rows.map((row, j) => (
                <Cell
                  key={row.month}
                  fill={colorForIndex(i)}
                  fillOpacity={j >= firstProjected ? 0.4 : 1}
                />
              ))}
            </Bar>
          ))}
          <Line
            type="monotone"
            dataKey="netSolid"
            name="Net"
            stroke="currentColor"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="netDashed"
            name="Net (projected)"
            stroke="currentColor"
            strokeWidth={2}
            strokeDasharray="4 4"
            dot={false}
            connectNulls
            legendType="none"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
