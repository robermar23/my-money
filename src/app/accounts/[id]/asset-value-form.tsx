"use client";

import { useActionState } from "react";
import { type ActionResult, recordAssetValueAction } from "./actions.ts";

const initial: ActionResult = {};

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

interface Props {
  readonly accountId: string;
}

/**
 * Record a personal asset's current value on a date (Phase 10, P10-12). A thin
 * sibling of `PropertyForm` bound to `recordAssetValueAction`, which UPSERTs the
 * `account_snapshots` row for `(account_id, date)` — re-recording a date
 * overwrites rather than duplicating.
 */
export function AssetValueForm({ accountId }: Props): React.JSX.Element {
  const bound = recordAssetValueAction.bind(null, accountId);
  const [state, action, pending] = useActionState(bound, initial);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label htmlFor="asset-date" className="block font-medium text-xs">
          Valuation date
        </label>
        <input
          id="asset-date"
          name="date"
          type="date"
          required
          defaultValue={today}
          className={fieldClass}
        />
      </div>
      <div>
        <label htmlFor="asset-value" className="block font-medium text-xs">
          Current value
        </label>
        <input
          id="asset-value"
          name="value"
          type="text"
          inputMode="decimal"
          required
          placeholder="28500.00"
          className={`${fieldClass} font-mono`}
        />
      </div>
      {state.error && (
        <p className="col-span-full rounded-md bg-red-50 px-3 py-2 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="col-span-full rounded-md bg-emerald-50 px-3 py-2 text-emerald-700 text-xs dark:bg-emerald-950 dark:text-emerald-300">
          Saved.
        </p>
      )}
      <div className="col-span-full">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {pending ? "Saving…" : "Save valuation"}
        </button>
      </div>
    </form>
  );
}
