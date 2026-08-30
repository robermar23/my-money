"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { WATERFALL_COLORS } from "../chart-colors.ts";
import type { BarTone, WaterfallBar } from "./view-models.ts";

/**
 * P17-21 — the net-worth waterfall, as a `'use client'` Recharts island
 * (ADR-005; recharts 3.8.1, pinned, no new chart dependency).
 *
 * ── Range bars, not a transparent base series ──────────────────────────────
 * PLAN17 sketches the usual Recharts waterfall trick: a stacked `BarChart` with
 * an invisible base bar holding the visible one aloft. That works only while
 * every value in the walk is positive. Recharts stacks positive and negative
 * segments into *separate* offsets, so the moment a household's running net
 * worth crosses zero — a real state in an app that tracks mortgages — the base
 * and the delta land on opposite sides of the axis and the chart draws a
 * confident, wrong picture.
 *
 * Recharts' `Bar` accepts an `[y0, y1]` tuple (`BarRectangleItem.value` is
 * typed `number | [number, number]`), which is the same visual with no sign
 * assumption at all. The endpoints come from the server already walked with
 * `Money`, so the bars chain exactly.
 *
 * ── Where `Number()` is allowed ────────────────────────────────────────────
 * Here, at the plotting call, and nowhere upstream (CLAUDE.md §Money: convert
 * at the final display step). Every amount the user READS — the tooltip figure
 * included — arrives pre-formatted from the server as a string. Nothing
 * computed in this file is read back into anything.
 *
 * ── Colour is not the only signal ──────────────────────────────────────────
 * `unexplained` is dashed as well as amber, so it stays separable from the loss
 * red without relying on hue. The chart is `aria-hidden`: the rung table beside
 * it is the text alternative and carries every figure plus its audit trail, so
 * a screen reader gets the better of the two rather than a list of bar values.
 */

interface Props {
  readonly bars: readonly WaterfallBar[];
  readonly currency: string;
}

interface Datum {
  readonly label: string;
  readonly range: [number, number];
  readonly amountDisplay: string;
  readonly tone: BarTone;
}

interface TooltipRenderProps {
  readonly active?: boolean;
  readonly payload?: readonly { readonly payload?: Datum }[];
}

function WaterfallTooltip({ active, payload }: TooltipRenderProps): React.JSX.Element | null {
  const datum = payload?.[0]?.payload;
  if (!active || datum === undefined) return null;

  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-100 shadow-lg">
      <div className="font-medium">{datum.label}</div>
      <div className="mt-0.5 font-mono tabular-nums">{datum.amountDisplay}</div>
    </div>
  );
}

export function AttributionWaterfallChart({ bars, currency }: Props): React.JSX.Element {
  const data: Datum[] = bars.map((bar) => ({
    label: bar.label,
    range: [Number(bar.start), Number(bar.end)],
    amountDisplay: bar.amountDisplay,
    tone: bar.tone,
  }));

  const axis = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
    notation: "compact",
  });

  return (
    // `min-w-0` and a percentage-width container: the chart shrinks with the
    // viewport instead of pushing the page into a horizontal scroll on a phone.
    <div aria-hidden="true" className="h-80 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-zinc-200 dark:stroke-zinc-800" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11 }}
            interval={0}
            angle={-35}
            textAnchor="end"
            height={56}
            className="fill-zinc-500"
          />
          <YAxis
            tickFormatter={(value: number) => axis.format(value)}
            tick={{ fontSize: 11 }}
            width={60}
            className="fill-zinc-500"
          />
          {/* Zero is always drawn: on a book with a mortgage the walk can cross
              it, and a waterfall whose baseline is invisible is unreadable. */}
          <ReferenceLine y={0} className="stroke-zinc-400 dark:stroke-zinc-600" />
          <Tooltip content={<WaterfallTooltip />} cursor={{ fillOpacity: 0.08 }} />
          <Bar dataKey="range" radius={2} isAnimationActive={false}>
            {data.map((datum) => (
              <Cell
                key={datum.label}
                fill={WATERFALL_COLORS[datum.tone]}
                stroke={datum.tone === "unknown" ? WATERFALL_COLORS.unknown : undefined}
                strokeDasharray={datum.tone === "unknown" ? "3 2" : undefined}
                strokeWidth={datum.tone === "unknown" ? 1.5 : 0}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
