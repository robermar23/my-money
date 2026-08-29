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
import type { ChartEventView, ProjectionPointView } from "./view-models.ts";

/**
 * P16-31 — the daily balance projection, as a `'use client'` Recharts island
 * (ADR-005). The server renders the wrapper and every figure around it; this
 * draws one line.
 *
 * ── Where `Number()` is allowed, and where it is not ───────────────────────
 * Only the plotted balance is converted, at the plotting call itself — Recharts
 * takes numbers and there is no way around that (CLAUDE.md §Money: convert at
 * the final display step). Every amount the user READS — the tooltip's event
 * figures, the axis is the only exception — arrives pre-formatted from the
 * server as a string. Nothing computed here is read back into anything.
 *
 * ── Two reference lines, and why the zero line is conditional ──────────────
 * The cash floor is drawn whenever the household set one, because the whole
 * safe-to-spend figure is measured against it and a line the number references
 * but the chart hides is a chart that disagrees with its own caption. Zero is
 * drawn only when the projection actually crosses it: on a healthy line it is
 * off-screen noise, and on a bad one it is the single most important thing on
 * the page.
 */

interface Props {
  readonly points: readonly ProjectionPointView[];
  readonly currency: string;
  /** The user's stated buffer, a `numeric` string. `"0.00"` draws no line. */
  readonly floor: string;
  /** The day the projection bottoms out, highlighted on the axis. */
  readonly lowWaterDate: string | null;
}

interface Datum {
  readonly date: string;
  readonly balance: number;
  readonly events: readonly ChartEventView[];
}

/** Recharts injects these; the shape is narrower than its own loose typing. */
interface TooltipRenderProps {
  readonly active?: boolean;
  readonly payload?: readonly { readonly payload?: Datum }[];
}

/** `"2026-03-14"` → `"Mar 14"`, in UTC so a calendar date never shifts a day. */
function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The day under the cursor: its projected balance and what moved that day.
 *
 * The events are the reason this tooltip exists rather than a bare value — a
 * cliff in the line is only useful if you can see it is the mortgage.
 */
function ProjectionTooltip({
  active,
  payload,
  format,
}: TooltipRenderProps & { readonly format: Intl.NumberFormat }): React.JSX.Element | null {
  const datum = payload?.[0]?.payload;
  if (!active || datum === undefined) return null;

  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-100 shadow-lg">
      <div className="font-medium">{shortDate(datum.date)}</div>
      <div className="mt-0.5 font-mono tabular-nums">{format.format(datum.balance)}</div>
      {datum.events.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 border-zinc-700 border-t pt-1.5">
          {datum.events.map((event) => (
            <li key={`${event.label}:${event.amountDisplay}`} className="flex gap-2">
              <span className={event.direction === "inflow" ? "text-emerald-400" : "text-red-400"}>
                {event.direction === "inflow" ? "+" : "−"}
              </span>
              <span className="grow">{event.label}</span>
              <span className="font-mono tabular-nums">{event.amountDisplay}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ProjectionChart({
  points,
  currency,
  floor,
  lowWaterDate,
}: Props): React.JSX.Element {
  if (points.length < 2) {
    return (
      <div className="flex h-72 items-center justify-center rounded-md border border-zinc-200 border-dashed p-4 text-center text-sm text-zinc-500 dark:border-zinc-800">
        There is no horizon to draw yet.
      </div>
    );
  }

  const data: Datum[] = points.map((point) => ({
    date: point.date,
    balance: Number(point.closing),
    events: point.events,
  }));

  const floorValue = Number(floor);
  const crossesZero = data.some((d) => d.balance < 0);

  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });

  return (
    <div className="h-72 w-full text-sky-600 dark:text-sky-400">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="cashflow-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.2} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="currentColor" strokeOpacity={0.1} vertical={false} />
          <XAxis
            dataKey="date"
            stroke="currentColor"
            tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.6 }}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
            tickFormatter={shortDate}
          />
          <YAxis
            stroke="currentColor"
            tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.6 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => fmt.format(v)}
            width={80}
          />
          <Tooltip content={<ProjectionTooltip format={fmt} />} />

          {crossesZero && <ReferenceLine y={0} stroke="#dc2626" strokeWidth={1} />}
          {floorValue > 0 && (
            <ReferenceLine
              y={floorValue}
              stroke="#d97706"
              strokeDasharray="3 3"
              label={{
                value: "Your cushion",
                position: "insideTopRight",
                fontSize: 11,
                fill: "#d97706",
              }}
            />
          )}
          {lowWaterDate !== null && (
            <ReferenceLine
              x={lowWaterDate}
              stroke="currentColor"
              strokeOpacity={0.4}
              strokeDasharray="3 3"
              label={{
                value: "Lowest",
                position: "top",
                fontSize: 11,
                fill: "currentColor",
                fillOpacity: 0.7,
              }}
            />
          )}

          <Area
            type="monotone"
            dataKey="balance"
            stroke="currentColor"
            strokeWidth={2}
            fill="url(#cashflow-fill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
