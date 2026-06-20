"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteSnapshotAction } from "./actions.ts";

/**
 * P7-13 — Per-row delete control for a balance snapshot. Mirrors
 * {@link DeleteHoldingButton} (useTransition + router.refresh). Confirms first,
 * since it removes a historical data point. Useful for clearing a wrong-dated
 * manual balance (same-date mistakes are fixed by re-recording the balance).
 */
export function DeleteSnapshotButton({
  accountId,
  date,
}: {
  readonly accountId: string;
  readonly date: string;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onDelete(): void {
    if (!window.confirm(`Delete the balance recorded on ${date}?`)) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteSnapshotAction(accountId, date);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={onDelete}
        disabled={pending}
        className="text-red-600 text-xs hover:underline disabled:opacity-50 dark:text-red-400"
      >
        {pending ? "Deleting…" : "Delete"}
      </button>
      {error && <span className="ml-1 text-red-600 text-xs dark:text-red-400">{error}</span>}
    </>
  );
}
