"use client";

import { useActionState } from "react";
import type { WatchlistActionResult } from "../actions.ts";

const initial: WatchlistActionResult = {};

const fieldClass =
  "w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

interface Props {
  /** `createPriceTargetAction` already bound to this item's id. */
  readonly action: (
    prev: WatchlistActionResult,
    formData: FormData,
  ) => Promise<WatchlistActionResult>;
}

/**
 * P11-18 — add a one-shot price target. "Above" fires when the close reaches or
 * exceeds the threshold; "below" when it falls to or under it (inclusive, per
 * ADR-026). The form resets via `key` on the surrounding section after a
 * successful add (server revalidation re-renders it).
 */
export function AddTargetForm({ action }: Props): React.JSX.Element {
  const [state, formAction, pending] = useActionState(action, initial);

  return (
    <form action={formAction} className="mt-4 flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="direction" className="block text-xs text-zinc-500">
          Direction
        </label>
        <select
          id="direction"
          name="direction"
          className={`mt-1 ${fieldClass}`}
          defaultValue="above"
        >
          <option value="above">Rises to / above</option>
          <option value="below">Falls to / below</option>
        </select>
      </div>
      <div>
        <label htmlFor="threshold" className="block text-xs text-zinc-500">
          Price
        </label>
        <input
          id="threshold"
          name="threshold"
          type="text"
          inputMode="decimal"
          required
          placeholder="200.00"
          className={`mt-1 font-mono ${fieldClass}`}
        />
      </div>
      <div className="grow">
        <label htmlFor="note" className="block text-xs text-zinc-500">
          Note <span className="text-zinc-400">(optional)</span>
        </label>
        <input
          id="note"
          name="note"
          type="text"
          maxLength={120}
          placeholder="sell target"
          className={`mt-1 ${fieldClass}`}
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-zinc-900 px-4 py-2 font-medium text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {pending ? "Adding…" : "Add target"}
      </button>
      {state.error && (
        <p className="w-full rounded-md bg-red-50 px-3 py-2 text-red-700 text-sm dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      )}
    </form>
  );
}
