"use client";

import { Button } from "@/components/ui/button.tsx";
import type { Confidence, Recommendation, Severity } from "@/lib/advice/types.ts";
import { Money } from "@/lib/money/money.ts";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { dismissRecommendationAction } from "./actions.ts";
import { InputsUsed } from "./inputs-used.tsx";

/**
 * The ranked recommendation list (Phase 15, P15-33/P15-34).
 *
 * Order is decided by `sortRecommendations` (P15-23) — severity, then whether
 * the item is actionable, then impact. This component never re-sorts and never
 * filters: what the engine returned is what the user sees, in that order. A UI
 * that quietly hid the `ok` and `unknown_input` items would produce a page that
 * looks confident on a household the app knows almost nothing about.
 *
 * ── Why dismiss lives here and not on the server ───────────────────────────
 * Dismissing is the one write on this page, and it needs to feel like closing a
 * notification rather than submitting a form. The action itself is a server
 * action (`recommendation_dismissals` is server state); this component only owns
 * the pending flag and the snooze choice.
 *
 * ── Snooze vs. dismiss ─────────────────────────────────────────────────────
 * Both are offered because they mean different things. "Not now" is a real
 * answer to *build your emergency fund* in a month where that is not possible,
 * and it should not require the user to remember to un-dismiss it later. A
 * snooze returns on its own; a dismissal waits for an explicit undo.
 */

interface Props {
  readonly recommendations: readonly Recommendation[];
  readonly currency: string;
}

const SEVERITY_BADGE: Readonly<Record<Severity, string>> = {
  critical: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  info: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
};

const CONFIDENCE_NOTE: Readonly<Record<Confidence, string>> = {
  high: "",
  medium: "Medium confidence — some inputs are estimated or thin.",
  low: "Low confidence — this rests on inputs that are missing or barely populated.",
};

/** Snooze options, in days. `0` is the permanent dismissal. */
const SNOOZE_CHOICES: readonly { readonly days: number; readonly label: string }[] = [
  { days: 30, label: "Not now (30 days)" },
  { days: 90, label: "Not this quarter (90 days)" },
  { days: 0, label: "Dismiss for good" },
];

function money(value: string, currency: string): string {
  return Money.fromString(value, currency).format();
}

export function RecommendationList({ recommendations, currency }: Props): React.JSX.Element {
  return (
    <ul className="mt-4 space-y-3">
      {recommendations.map((recommendation) => (
        <RecommendationCard
          key={recommendation.id}
          recommendation={recommendation}
          currency={currency}
        />
      ))}
    </ul>
  );
}

function RecommendationCard({
  recommendation,
  currency,
}: {
  readonly recommendation: Recommendation;
  readonly currency: string;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const confidenceNote = CONFIDENCE_NOTE[recommendation.confidence];
  const unknown = recommendation.status === "unknown_input";
  const satisfied = recommendation.status === "ok";

  function dismiss(days: number): void {
    setError(null);
    setMenuOpen(false);
    const formData = new FormData();
    formData.set("ruleId", recommendation.ruleId);
    formData.set("subjectKey", recommendation.subjectKey);
    formData.set("snoozeDays", days > 0 ? String(days) : "");

    startTransition(async () => {
      const result = await dismissRecommendationAction({}, formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <li
      data-tour="plan-recommendation"
      className={`rounded-lg border p-4 ${
        satisfied
          ? "border-zinc-200 dark:border-zinc-800"
          : unknown
            ? "border-amber-300 bg-amber-50/40 dark:border-amber-900/60 dark:bg-amber-950/10"
            : "border-zinc-300 dark:border-zinc-700"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 font-medium text-xs ${SEVERITY_BADGE[recommendation.severity]}`}
            >
              {recommendation.severity}
            </span>
            {unknown && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 text-xs dark:bg-amber-950 dark:text-amber-300">
                missing an input
              </span>
            )}
            <h3 className="font-medium text-sm">{recommendation.title}</h3>
          </div>

          <p className="mt-1.5 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
            {recommendation.rationale}
          </p>

          {/* The named heuristic (ADR-032 §2). An unnamed rule of thumb is an
              unfalsifiable one, so it is always shown, never in a tooltip. */}
          <p className="mt-1.5 text-xs text-zinc-500">
            Rule of thumb: <span className="italic">{recommendation.heuristic}</span>
          </p>

          {(recommendation.currentValue !== null || recommendation.suggestedValue !== null) && (
            <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs">
              {recommendation.currentValue !== null && (
                <div>
                  <dt className="text-zinc-500">Now</dt>
                  <dd className="font-mono tabular-nums">
                    {money(recommendation.currentValue, currency)}
                  </dd>
                </div>
              )}
              {recommendation.suggestedValue !== null && (
                <div>
                  <dt className="text-zinc-500">Suggested</dt>
                  <dd className="font-mono tabular-nums">
                    {money(recommendation.suggestedValue, currency)}
                  </dd>
                </div>
              )}
              {recommendation.impact !== null && (
                <div>
                  <dt className="text-zinc-500">Gap</dt>
                  <dd className="font-mono tabular-nums">
                    {money(recommendation.impact, currency)}
                  </dd>
                </div>
              )}
            </dl>
          )}

          {confidenceNote && <p className="mt-2 text-xs text-zinc-500">{confidenceNote}</p>}

          <InputsUsed inputs={recommendation.inputsUsed} />

          {error && (
            <p className="mt-2 rounded-md bg-red-50 px-2 py-1 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
              {error}
            </p>
          )}
        </div>

        <div className="relative shrink-0">
          <Button
            type="button"
            data-tour="plan-hide"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            variant="secondary"
            size="xs"
            pending={pending}
            pendingLabel="Hiding…"
          >
            Hide
          </Button>
          {menuOpen && (
            <div className="absolute right-0 z-10 mt-1 w-56 rounded-md border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
              {SNOOZE_CHOICES.map((choice) => (
                <button
                  key={choice.days}
                  type="button"
                  onClick={() => dismiss(choice.days)}
                  className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {choice.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
