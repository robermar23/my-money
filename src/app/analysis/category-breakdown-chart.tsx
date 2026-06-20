"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { colorForIndex } from "./chart-colors.ts";

/**
 * P8-14 — Expense breakdown donut (ADR-013). Client island; the server computes
 * the slices (positive spend magnitudes) and passes display-ready values. The
 * single `Number()` display-edge conversion happens upstream in the page.
 */
interface Slice {
  readonly id: string;
  readonly name: string;
  readonly value: number;
}

interface Props {
  readonly slices: readonly Slice[];
  readonly currency: string;
}

export function CategoryBreakdownChart({ slices, currency }: Props): React.JSX.Element {
  if (slices.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border border-zinc-200 border-dashed text-sm text-zinc-500 dark:border-zinc-800">
        No categorized spending in this range.
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
        <PieChart>
          <Pie
            data={slices as Slice[]}
            dataKey="value"
            nameKey="name"
            innerRadius={55}
            outerRadius={90}
            paddingAngle={2}
            stroke="none"
          >
            {slices.map((s, i) => (
              <Cell key={s.id} fill={colorForIndex(i)} />
            ))}
          </Pie>
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
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
