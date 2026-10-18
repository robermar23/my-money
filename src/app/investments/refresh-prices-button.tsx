"use client";

import { Button } from "@/components/ui/button.tsx";
import { useState, useTransition } from "react";
import { refreshPricesAction } from "./actions.ts";

/**
 * "Refresh prices" button — enqueues the price-fetch job (Yahoo + CoinGecko) and
 * shows a transient confirmation. The fetch runs in the worker; prices typically
 * land within a few seconds, so we prompt the user to reload shortly after.
 */
export function RefreshPricesButton(): React.JSX.Element {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function onClick(): void {
    setMsg(null);
    startTransition(async () => {
      const res = await refreshPricesAction();
      setMsg(
        res.error
          ? res.error
          : "Queued — prices update in a few seconds. Reload the page to see them.",
      );
    });
  }

  return (
    <div className="mt-3">
      <Button
        type="button"
        onClick={onClick}
        variant="secondary"
        pending={pending}
        pendingLabel="Queuing…"
      >
        Refresh prices
      </Button>
      {msg && <p className="mt-1 text-xs text-zinc-500">{msg}</p>}
    </div>
  );
}
