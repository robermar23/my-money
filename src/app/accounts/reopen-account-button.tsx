"use client";

import { Button } from "@/components/ui/button.tsx";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { reopenAccountAction } from "./[id]/actions.ts";

/**
 * Inline "Reopen" control for a closed account on the accounts list. Mirrors the
 * delete-holding-button pattern (useTransition + router.refresh).
 */
export function ReopenAccountButton({
  accountId,
}: {
  readonly accountId: string;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onReopen(): void {
    setError(null);
    startTransition(async () => {
      const res = await reopenAccountAction(accountId);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        onClick={onReopen}
        variant="quiet"
        size="xs"
        pending={pending}
        pendingLabel="Reopening…"
      >
        Reopen
      </Button>
      {error && <span className="ml-1 text-red-600 text-xs dark:text-red-400">{error}</span>}
    </>
  );
}
