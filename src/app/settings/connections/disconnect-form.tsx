"use client";

import { useState, useTransition } from "react";
import { disconnectItemAction } from "./actions.ts";

interface Props {
  plaidItemPk: string;
}

/**
 * P4-26 — Disconnect button + native confirm() guard.
 *
 * Disconnect is destructive of the Plaid linkage (tear-down + token wipe) but
 * intentionally preserves all transactions + snapshots. The native confirm
 * dialog is sufficient guard for the single-user app — anything richer would
 * be overkill per CLAUDE.md "Don't add features ... beyond what the task
 * requires."
 */
export function DisconnectForm({ plaidItemPk }: Props): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handle = () => {
    if (
      !window.confirm(
        "Disconnect this institution? Your transactions and history stay; only the live Plaid link is severed.",
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await disconnectItemAction(plaidItemPk);
      if (result.error) setError(result.error);
    });
  };

  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={handle}
        disabled={pending}
        className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        {pending ? "Disconnecting…" : "Disconnect"}
      </button>
      {error && <p className="mt-1 text-red-600 text-xs dark:text-red-400">{error}</p>}
    </div>
  );
}
