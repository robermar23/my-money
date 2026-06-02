"use client";

import { useState, useTransition } from "react";
import { forceSyncAction } from "./actions.ts";

interface Props {
  plaidItemPk: string;
  disabled?: boolean;
}

/**
 * P4-28 — Force sync button.
 *
 * Enqueues a manual-trigger `sync-plaid-item` job. The button enters a brief
 * "Queued" state and clears once the server action returns — the user gets
 * to confirm the request went through without waiting for the sync itself to
 * finish (the per-Item panel below the button surfaces the run as it lands).
 */
export function ForceSyncButton({ plaidItemPk, disabled }: Props): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [pending, startTransition] = useTransition();

  const handle = (): void => {
    setError(null);
    setQueued(false);
    startTransition(async () => {
      const result = await forceSyncAction(plaidItemPk);
      if (result.error) {
        setError(result.error);
      } else {
        setQueued(true);
        setTimeout(() => setQueued(false), 2_000);
      }
    });
  };

  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={handle}
        disabled={pending || disabled}
        className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        {pending ? "Queuing…" : queued ? "Queued ✓" : "Force sync"}
      </button>
      {error && <p className="mt-1 text-red-600 text-xs dark:text-red-400">{error}</p>}
    </div>
  );
}
