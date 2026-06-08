"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

/**
 * P5-22 — Asset-allocation donut (ADR-013). Recharts Client Component island;
 * the server computes the slices (src/lib/investments/allocation.ts) and passes
 * display-ready numbers. Percents already sum to exactly 100.00.
 */

interface Slice {
  readonly label: string;
  readonly value: number;
  readonly percent: string;
  readonly valueFormatted: string;
}

interface Props {
  readonly slices: readonly Slice[];
}

const COLORS: Record<string, string> = {
  equity: "#3b82f6",
  crypto: "#f59e0b",
  physical_metal: "#eab308",
  cash: "#10b981",
  property: "#8b5cf6",
};
const FALLBACK = "#71717a";

const LABELS: Record<string, string> = {
  equity: "Equity",
  crypto: "Crypto",
  physical_metal: "Physical metal",
  cash: "Cash",
  property: "Property",
};

export function AllocationChart({ slices }: Props): React.JSX.Element {
  if (slices.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border border-zinc-200 border-dashed text-sm text-zinc-500 dark:border-zinc-800">
        No priced holdings yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <div className="h-56 w-56 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices as Slice[]}
              dataKey="value"
              nameKey="label"
              innerRadius={55}
              outerRadius={85}
              paddingAngle={2}
              stroke="none"
            >
              {slices.map((s) => (
                <Cell key={s.label} fill={COLORS[s.label] ?? FALLBACK} />
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
              formatter={(value, name) => [
                `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
                LABELS[String(name)] ?? String(name),
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex-1 space-y-1 text-sm">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: COLORS[s.label] ?? FALLBACK }}
              />
              {LABELS[s.label] ?? s.label}
            </span>
            <span className="font-mono text-zinc-600 tabular-nums dark:text-zinc-400">
              {s.percent}% · {s.valueFormatted}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
