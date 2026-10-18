"use client";

import { Button } from "@/components/ui/button.tsx";
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
      <Button
        type="button"
        onClick={handle}
        disabled={disabled}
        variant="secondary"
        pending={pending}
        pendingLabel="Queuing…"
      >
        {queued ? "Queued ✓" : "Force sync"}
      </Button>
      {error && <p className="mt-1 text-red-600 text-xs dark:text-red-400">{error}</p>}
    </div>
  );
}
