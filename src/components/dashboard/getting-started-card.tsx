"use client";

import { closeChecklist, isChecklistClosed } from "@/lib/help/checklist-state.ts";
import { type ChecklistItem, isComplete } from "@/lib/help/checklist.ts";
import { useEffect, useState } from "react";
import { ChecklistList } from "./checklist-list.tsx";

/**
 * The getting-started checklist on the populated dashboard (PLAN20 P20-30).
 *
 * Dismissible, and gone for good once dismissed or once every item is done,
 * on this device (ADR-060). It renders nothing until it has read that mark, so
 * a closed checklist never flashes in on load.
 */

interface Props {
  readonly items: readonly ChecklistItem[];
}

export function GettingStartedCard({ items }: Props): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const complete = isComplete(items);

  useEffect(() => {
    if (complete) {
      closeChecklist("done");
      return;
    }
    setOpen(!isChecklistClosed());
  }, [complete]);

  if (!open) return null;
  const done = items.filter((item) => item.done).length;
  return (
    <section
      aria-labelledby="getting-started-heading"
      className="mb-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 id="getting-started-heading" className="font-medium text-sm">
            Getting started
          </h2>
          <p className="text-xs text-zinc-500">
            {done} of {items.length} done. This goes away once they all are.
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss getting started"
          onClick={() => {
            closeChecklist("dismissed");
            setOpen(false);
          }}
          className="-mt-1 -mr-1 flex h-8 w-8 items-center justify-center rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <ChecklistList items={items} />
    </section>
  );
}
