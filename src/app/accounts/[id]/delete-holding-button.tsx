"use client";

import { Button } from "@/components/ui/button.tsx";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteHoldingAction } from "./actions.ts";

/**
 * Per-row delete control for a holding. Mirrors the lot-delete pattern
 * (useTransition + router.refresh). Confirms first, since it's destructive.
 */
export function DeleteHoldingButton({
  accountId,
  holdingId,
  symbol,
}: {
  readonly accountId: string;
  readonly holdingId: string;
  readonly symbol: string;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onDelete(): void {
    if (!window.confirm(`Delete holding ${symbol}? This can't be undone for manual holdings.`)) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await deleteHoldingAction(accountId, holdingId);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        onClick={onDelete}
        variant="danger-quiet"
        size="xs"
        pending={pending}
        pendingLabel="Deleting…"
      >
        Delete
      </Button>
      {error && <span className="ml-1 text-red-600 text-xs dark:text-red-400">{error}</span>}
    </>
  );
}
