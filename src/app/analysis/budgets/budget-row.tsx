"use client";

import { Button } from "@/components/ui/button.tsx";
import type { BudgetLine } from "@/lib/budgets/queries.ts";
import { useActionState, useTransition } from "react";
import { type BudgetActionResult, deleteBudgetAction, setBudgetAction } from "./actions.ts";

interface Props {
  readonly line: BudgetLine;
  readonly currency: string;
}

function fmt(value: string, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value));
}

/**
 * One budget row (P8-19): inline monthly-target input + a target-vs-actual
 * progress bar. Over budget = red, under = green. The target input is a server
 * action ({@link setBudgetAction}); clearing removes the budget. URL/server
 * state drives the displayed actual — this island only owns the input.
 */
export function BudgetRow({ line, currency }: Props): React.JSX.Element {
  const [state, formAction, pending] = useActionState<BudgetActionResult, FormData>(
    setBudgetAction,
    {},
  );
  const [clearing, startClear] = useTransition();

  const over = Number(line.remaining) < 0;
  // Bar fills toward 100%; over-budget pins full + turns red.
  const width = Math.min(line.pct, 100);
  const barColor = over ? "bg-red-500" : "bg-emerald-500";

  // Run-rate projection (in-progress month only). A tick on the bar marks where
  // spend is trending; the % is a display-edge ratio against the target.
  const hasProjection = line.projected !== null;
  const projectedNum = hasProjection ? Number(line.projected) : 0;
  const projectedPct =
    line.hasBudget && Number(line.target) > 0
      ? Math.min((projectedNum / Number(line.target)) * 100, 100)
      : null;
  const projectedOver = line.hasBudget && projectedNum > Number(line.target);

  return (
    <div
      data-tour="budgets-row"
      className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 py-2"
    >
      <div className="min-w-0">
        <div className="truncate text-sm">{line.name}</div>
        <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div className={`h-full ${barColor}`} style={{ width: `${width}%` }} />
          {projectedPct !== null && (
            <div
              className={`absolute top-[-1px] bottom-[-1px] w-0.5 ${
                projectedOver ? "bg-red-700" : "bg-zinc-500"
              }`}
              style={{ left: `calc(${projectedPct}% - 1px)` }}
              aria-hidden
            />
          )}
        </div>
        <div className="mt-1 text-xs text-zinc-500">
          {fmt(line.actual, currency)}
          {line.hasBudget ? (
            <>
              {" of "}
              {fmt(line.target, currency)}
              <span className={over ? "ml-2 text-red-600" : "ml-2 text-emerald-600"}>
                {over
                  ? `${fmt(String(-Number(line.remaining)), currency)} over`
                  : `${fmt(line.remaining, currency)} left`}
              </span>
            </>
          ) : (
            <span className="ml-1 text-zinc-400">no budget</span>
          )}
          {hasProjection && (
            <span
              className="ml-2 text-zinc-400"
              title="Projected end-of-month at the current run-rate"
            >
              · ~{fmt(line.projected ?? "0", currency)} projected
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <form data-tour="budgets-target" action={formAction} className="flex items-center gap-1.5">
          <input type="hidden" name="categoryId" value={line.categoryId} />
          <span className="text-xs text-zinc-400">$</span>
          <input
            type="text"
            inputMode="decimal"
            name="amount"
            defaultValue={line.hasBudget ? line.target : ""}
            placeholder="0.00"
            aria-label={`Monthly budget for ${line.name}`}
            className="w-24 rounded-md border border-zinc-300 px-2 py-1 text-right text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
          />
          <Button
            type="submit"
            variant="commit"
            size="xs"
            pending={pending}
            pendingLabel="…"
            succeeded={!state.error}
          >
            Save
          </Button>
        </form>
        {line.hasBudget && (
          <button
            type="button"
            disabled={clearing}
            onClick={() => startClear(() => void deleteBudgetAction(line.categoryId))}
            aria-label={`Clear budget for ${line.name}`}
            className="rounded-md px-1.5 py-1 text-xs text-zinc-400 hover:text-red-600 disabled:opacity-40"
          >
            ✕
          </button>
        )}
      </div>

      {state.error && <p className="col-span-2 text-red-600 text-xs">{state.error}</p>}
    </div>
  );
}
