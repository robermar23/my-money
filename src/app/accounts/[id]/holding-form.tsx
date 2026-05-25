"use client";

import { useActionState } from "react";
import { type ActionResult, upsertHoldingAction } from "./actions.ts";

const initial: ActionResult = {};

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

const ASSET_CLASSES = [
  { value: "equity", label: "Equity (stocks / ETFs)" },
  { value: "crypto", label: "Crypto" },
  { value: "physical_metal", label: "Physical metal" },
  { value: "cash", label: "Cash" },
] as const;

const UNITS = [
  { value: "shares", label: "shares" },
  { value: "coin", label: "coin" },
  { value: "troy_oz", label: "troy_oz" },
  { value: "usd", label: "usd" },
] as const;

interface Props {
  readonly accountId: string;
}

export function HoldingForm({ accountId }: Props): React.JSX.Element {
  const bound = upsertHoldingAction.bind(null, accountId);
  const [state, action, pending] = useActionState(bound, initial);

  return (
    <form action={action} className="grid grid-cols-2 gap-3">
      <div>
        <label htmlFor="symbol" className="block font-medium text-xs">
          Symbol
        </label>
        <input
          id="symbol"
          name="symbol"
          type="text"
          required
          maxLength={20}
          placeholder="AAPL / XAU / BTC"
          className={`${fieldClass} font-mono uppercase`}
        />
      </div>
      <div>
        <label htmlFor="assetClass" className="block font-medium text-xs">
          Asset class
        </label>
        <select id="assetClass" name="assetClass" required className={fieldClass}>
          {ASSET_CLASSES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="quantity" className="block font-medium text-xs">
          Quantity
        </label>
        <input
          id="quantity"
          name="quantity"
          type="text"
          inputMode="decimal"
          required
          placeholder="100 or 5.0"
          className={`${fieldClass} font-mono`}
        />
      </div>
      <div>
        <label htmlFor="quantityUnit" className="block font-medium text-xs">
          Unit
        </label>
        <select id="quantityUnit" name="quantityUnit" required className={fieldClass}>
          {UNITS.map((u) => (
            <option key={u.value} value={u.value}>
              {u.label}
            </option>
          ))}
        </select>
      </div>
      <div className="col-span-2">
        <label htmlFor="costBasis" className="block font-medium text-xs">
          Cost basis (optional)
        </label>
        <input
          id="costBasis"
          name="costBasis"
          type="text"
          inputMode="decimal"
          placeholder="leave blank if unknown (common for IRA gold)"
          className={`${fieldClass} font-mono`}
        />
      </div>
      {state.error && (
        <p className="col-span-2 rounded-md bg-red-50 px-3 py-2 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="col-span-2 rounded-md bg-emerald-50 px-3 py-2 text-emerald-700 text-xs dark:bg-emerald-950 dark:text-emerald-300">
          Saved.
        </p>
      )}
      <div className="col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {pending ? "Saving…" : "Save holding"}
        </button>
      </div>
    </form>
  );
}
