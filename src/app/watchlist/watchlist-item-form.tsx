"use client";

import { Button } from "@/components/ui/button.tsx";
import { useActionState } from "react";
import type { WatchlistActionResult } from "./actions.ts";

const initial: WatchlistActionResult = {};

/** Labels mirror WATCHLIST_ASSET_CLASSES in schemas/watchlist.ts. */
const ASSET_CLASS_OPTIONS = [
  { value: "equity", label: "Stock / ETF" },
  { value: "crypto", label: "Crypto" },
  { value: "physical_metal", label: "Metal (gold, silver…)" },
] as const;

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

export interface WatchlistFormDefaults {
  readonly symbol?: string;
  readonly assetClass?: string;
  readonly label?: string | null;
  readonly pretendQuantity?: string | null;
  readonly pretendUnitCost?: string | null;
  readonly pretendPurchasedAt?: string | null;
  readonly currency?: string;
  readonly notes?: string | null;
}

interface Props {
  /** A `useActionState`-shaped action (create, or edit bound to an id). */
  readonly action: (
    prev: WatchlistActionResult,
    formData: FormData,
  ) => Promise<WatchlistActionResult>;
  readonly defaults?: WatchlistFormDefaults;
  readonly submitLabel: string;
}

/**
 * P11-16 — add/edit a watchlist item. The optional "pretend" buy is all-or-
 * nothing (quantity + unit cost + date together) — the schema and DB CHECK both
 * enforce it; the helper text says so. Symbol/label/notes are user-entered and
 * rendered as React text everywhere (no `dangerouslySetInnerHTML`), so they're
 * escaped by default (P11-22).
 */
export function WatchlistItemForm({ action, defaults, submitLabel }: Props): React.JSX.Element {
  const [state, formAction, pending] = useActionState(action, initial);

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="symbol" className="block font-medium text-sm">
            Symbol
          </label>
          <input
            id="symbol"
            name="symbol"
            type="text"
            required
            maxLength={20}
            placeholder="AAPL"
            defaultValue={defaults?.symbol ?? ""}
            className={`${fieldClass} font-mono uppercase`}
          />
        </div>
        <div>
          <label htmlFor="assetClass" className="block font-medium text-sm">
            Type
          </label>
          <select
            id="assetClass"
            name="assetClass"
            required
            defaultValue={defaults?.assetClass ?? "equity"}
            className={fieldClass}
          >
            {ASSET_CLASS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="label" className="block font-medium text-sm">
          Display name <span className="text-zinc-400">(optional)</span>
        </label>
        <input
          id="label"
          name="label"
          type="text"
          maxLength={120}
          placeholder="Apple Inc."
          defaultValue={defaults?.label ?? ""}
          className={fieldClass}
        />
      </div>

      <fieldset className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 font-medium text-sm">
          Pretend position <span className="text-zinc-400">(optional)</span>
        </legend>
        <p className="text-xs text-zinc-500">
          Model a hypothetical buy to see a simple gain/loss. Fill all three or leave them blank —
          this never affects net worth and is never tax or realized P&amp;L.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="pretendQuantity" className="block font-medium text-sm">
              Quantity
            </label>
            <input
              id="pretendQuantity"
              name="pretendQuantity"
              type="text"
              inputMode="decimal"
              placeholder="10"
              defaultValue={defaults?.pretendQuantity ?? ""}
              className={`${fieldClass} font-mono`}
            />
          </div>
          <div>
            <label htmlFor="pretendUnitCost" className="block font-medium text-sm">
              Cost / unit
            </label>
            <input
              id="pretendUnitCost"
              name="pretendUnitCost"
              type="text"
              inputMode="decimal"
              placeholder="150.00"
              defaultValue={defaults?.pretendUnitCost ?? ""}
              className={`${fieldClass} font-mono`}
            />
          </div>
          <div>
            <label htmlFor="pretendPurchasedAt" className="block font-medium text-sm">
              Purchase date
            </label>
            <input
              id="pretendPurchasedAt"
              name="pretendPurchasedAt"
              type="date"
              defaultValue={defaults?.pretendPurchasedAt ?? ""}
              className={fieldClass}
            />
          </div>
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="currency" className="block font-medium text-sm">
            Currency
          </label>
          <input
            id="currency"
            name="currency"
            type="text"
            maxLength={3}
            minLength={3}
            defaultValue={defaults?.currency ?? "USD"}
            className={fieldClass}
          />
        </div>
      </div>

      <div>
        <label htmlFor="notes" className="block font-medium text-sm">
          Notes <span className="text-zinc-400">(optional)</span>
        </label>
        <input
          id="notes"
          name="notes"
          type="text"
          maxLength={2000}
          defaultValue={defaults?.notes ?? ""}
          className={fieldClass}
        />
      </div>

      {state.error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-red-700 text-sm dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      )}

      <Button
        type="submit"
        variant="commit"
        size="md"
        className="w-full"
        pending={pending}
        pendingLabel="Saving…"
      >
        {submitLabel}
      </Button>
    </form>
  );
}
