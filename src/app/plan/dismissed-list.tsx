"use client";

import { Button } from "@/components/ui/button.tsx";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { restoreRecommendationAction } from "./actions.ts";

/**
 * The dismissed-items view and its undo (Phase 15, P15-34).
 *
 * ── Why hidden items are listed at all ─────────────────────────────────────
 * `recommendation_dismissals` is the only persisted advice state in the app, and
 * it is state the user created by clicking something once. Without this panel it
 * would be *invisible and irreversible* — a page that has quietly stopped
 * mentioning a $9,000 high-interest balance because of a click nine months ago,
 * with no way to find out. Every suppression the engine applied is reported back
 * here, with the date it was applied and a one-click undo.
 *
 * A snoozed item shows its return date rather than "hidden": a user who chose
 * "not this quarter" should be able to confirm the app is actually going to
 * bring it back, without trusting that it will.
 *
 * Collapsed by default — this is a receipt, not a to-do list.
 */

export interface DismissedItem {
  readonly id: string;
  readonly ruleId: string;
  readonly subjectKey: string;
  readonly title: string;
  /** ISO timestamp of the dismissal. */
  readonly dismissedAt: string;
  /** ISO timestamp the snooze expires, or `null` for an indefinite dismissal. */
  readonly snoozeUntil: string | null;
}

interface Props {
  readonly items: readonly DismissedItem[];
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" });
}

export function DismissedList({ items }: Props): React.JSX.Element | null {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (items.length === 0) return null;

  function restore(ruleId: string, subjectKey: string): void {
    setError(null);
    startTransition(async () => {
      const result = await restoreRecommendationAction(ruleId, subjectKey);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <details className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <summary className="font-medium text-sm">Hidden by you ({items.length})</summary>
      <p className="mt-2 text-sm text-zinc-500">
        These are still being computed — they are only hidden from the list above.
      </p>

      {error && (
        <p className="mt-2 rounded-md bg-red-50 px-2 py-1 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-900">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <div className="text-sm">{item.title}</div>
              <div className="text-xs text-zinc-500">
                Hidden {dateLabel(item.dismissedAt)}
                {item.snoozeUntil
                  ? ` — comes back ${dateLabel(item.snoozeUntil)}`
                  : " — until you undo it"}
              </div>
            </div>
            <Button
              type="button"
              disabled={pending}
              onClick={() => restore(item.ruleId, item.subjectKey)}
              variant="secondary"
              size="xs"
              className="shrink-0"
            >
              Show again
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}
