"use client";

import { Button } from "@/components/ui/button.tsx";
import type {
  BudgetSuggestionPreview,
  BudgetSuggestionsResult,
} from "@/lib/budgets/suggestions.ts";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { applyBudgetSuggestionsAction } from "./actions.ts";

/**
 * The preview half of preview → confirm for suggested budgets (P15-27).
 *
 * CLAUDE.md §Importers is explicit that a file upload never silently mutates the
 * database, and a bulk budget write is the same shape of action: one click that
 * rewrites a dozen rows the user cannot easily reconstruct afterwards. So this
 * panel shows **every row it would write, what is stored today, and what the
 * suggestion is based on**, and writes nothing until the user presses Apply.
 *
 * Three properties are deliberate:
 *
 *   - **`unchanged` rows start unticked.** They are listed so the user can see
 *     the category was considered — silence about a category reads as a bug —
 *     but selecting them by default would inflate the "12 budgets applied"
 *     confirmation with writes that changed nothing.
 *   - **Amounts are editable before applying.** The suggestion is a starting
 *     point from the user's own median, not a verdict, and an amount they typed
 *     is one they own. {@link applyBudgetSuggestionsAction} takes exactly the
 *     rows submitted rather than re-deriving them, which is what keeps those
 *     edits from being discarded.
 *   - **The observed range is shown next to the target.** A median of $420 over
 *     a $180–$1,900 range is a very different number from a median of $420 over
 *     $400–$440, and only the range distinguishes them.
 *
 * Money discipline (CLAUDE.md §Money): amounts stay `numeric` strings the whole
 * way through; `Number` appears only inside the display formatter.
 */

interface Props {
  readonly preview: BudgetSuggestionsResult;
  readonly currency: string;
}

function fmt(value: string, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value));
}

const CHANGE_LABEL: Readonly<Record<BudgetSuggestionPreview["change"], string>> = {
  create: "New",
  update: "Change",
  unchanged: "Same",
};

const CONFIDENCE_NOTE: Readonly<Record<BudgetSuggestionPreview["confidence"], string>> = {
  high: "",
  medium: "based on a short history",
  low: "based on very little history",
};

export function SuggestionsPanel({ preview, currency }: Props): React.JSX.Element | null {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(preview.rows.filter((r) => r.recommended).map((r) => r.categoryId)),
  );
  const [amounts, setAmounts] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(preview.rows.map((r) => [r.categoryId, r.suggested])),
  );
  const [applied, setApplied] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  // Nothing to suggest is not an error state — it is a book with too little
  // history, or one whose budgets already match its spending.
  if (preview.rows.length === 0) return null;

  function toggle(categoryId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  }

  function apply(): void {
    setError(null);
    const targets = preview.rows
      .filter((row) => selected.has(row.categoryId))
      .map((row) => ({
        categoryId: row.categoryId,
        amount: amounts[row.categoryId] ?? row.suggested,
      }));
    if (targets.length === 0) {
      setError("Tick at least one category to apply.");
      return;
    }
    startTransition(async () => {
      const result = await applyBudgetSuggestionsAction(targets);
      if (result.error) {
        setError(result.error);
        return;
      }
      setApplied(result.applied ?? targets.length);
      router.refresh();
    });
  }

  const selectedCount = selected.size;

  return (
    <details
      data-tour="budgets-suggestions"
      className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <summary className="font-medium text-sm">
        Suggest budgets from your spending ({preview.rows.length})
      </summary>

      <p className="mt-2 text-sm text-zinc-500">
        Targets are the <strong>median</strong> of each category's last {preview.monthsConsidered}{" "}
        complete {preview.monthsConsidered === 1 ? "month" : "months"} — not the average, so one
        unusual month does not raise your budget for the rest of the year. Nothing is saved until
        you press Apply.
      </p>

      {applied !== null && (
        <p className="mt-2 rounded-md bg-emerald-50 px-2 py-1 text-emerald-700 text-xs dark:bg-emerald-950 dark:text-emerald-300">
          Applied {applied} {applied === 1 ? "budget" : "budgets"}.
        </p>
      )}
      {error && (
        <p className="mt-2 rounded-md bg-red-50 px-2 py-1 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-900">
        {preview.rows.map((row) => {
          const checked = selected.has(row.categoryId);
          return (
            <li key={row.categoryId} className="flex items-center gap-3 py-2">
              <input
                type="checkbox"
                id={`suggest-${row.categoryId}`}
                checked={checked}
                onChange={() => toggle(row.categoryId)}
                className="h-4 w-4 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <label htmlFor={`suggest-${row.categoryId}`} className="block truncate text-sm">
                  {row.name}
                  <span className="ml-2 text-xs text-zinc-400">{CHANGE_LABEL[row.change]}</span>
                </label>
                <div className="text-xs text-zinc-500">
                  {row.current === null
                    ? "No budget set"
                    : `Currently ${fmt(row.current, currency)}`}
                  {" · "}
                  {row.monthsWithSpend} of {row.basisMonths} months had spend, ranging{" "}
                  {fmt(row.observedRange.min, currency)}–{fmt(row.observedRange.max, currency)}
                  {CONFIDENCE_NOTE[row.confidence] && ` · ${CONFIDENCE_NOTE[row.confidence]}`}
                </div>
              </div>
              <input
                type="text"
                inputMode="decimal"
                aria-label={`Monthly target for ${row.name}`}
                value={amounts[row.categoryId] ?? row.suggested}
                onChange={(e) =>
                  setAmounts((prev) => ({ ...prev, [row.categoryId]: e.target.value }))
                }
                className="w-24 rounded-md border border-zinc-300 px-2 py-1 text-right font-mono text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
              />
            </li>
          );
        })}
      </ul>

      <Button
        type="button"
        onClick={apply}
        variant="commit"
        className="mt-3"
        pending={pending}
        pendingLabel="Applying…"
      >{`Apply ${selectedCount} ${selectedCount === 1 ? "budget" : "budgets"}`}</Button>
    </details>
  );
}
