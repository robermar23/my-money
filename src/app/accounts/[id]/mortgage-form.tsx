"use client";

import type { Liability } from "@/db/schema/index.ts";
import { useActionState } from "react";
import { type ActionResult, createOrUpdateMortgageAction } from "./actions.ts";

const initial: ActionResult = {};

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

interface Props {
  readonly accountId: string;
  readonly existing: Liability | null;
}

export function MortgageForm({ accountId, existing }: Props): React.JSX.Element {
  const bound = createOrUpdateMortgageAction.bind(null, accountId);
  const [state, action, pending] = useActionState(bound, initial);

  return (
    <form action={action} className="grid grid-cols-2 gap-3">
      <div className="col-span-2">
        <label htmlFor="mortgage-name" className="block font-medium text-xs">
          Loan name
        </label>
        <input
          id="mortgage-name"
          name="name"
          type="text"
          required
          maxLength={120}
          defaultValue={existing?.name ?? ""}
          placeholder="Sunwest 30yr fixed"
          className={fieldClass}
        />
      </div>
      <div>
        <label htmlFor="principal" className="block font-medium text-xs">
          Principal at origination
        </label>
        <input
          id="principal"
          name="principalAtOrigination"
          type="text"
          inputMode="decimal"
          required
          defaultValue={existing?.principalAtOrigination ?? ""}
          placeholder="350000.00"
          className={`${fieldClass} font-mono`}
        />
      </div>
      <div>
        <label htmlFor="rate" className="block font-medium text-xs">
          Annual rate (decimal)
        </label>
        <input
          id="rate"
          name="annualRate"
          type="text"
          inputMode="decimal"
          required
          defaultValue={existing?.annualRate ?? ""}
          placeholder="0.065 for 6.5%"
          className={`${fieldClass} font-mono`}
        />
      </div>
      <div>
        <label htmlFor="termMonths" className="block font-medium text-xs">
          Term (months)
        </label>
        <input
          id="termMonths"
          name="termMonths"
          type="number"
          min="1"
          max="600"
          required
          defaultValue={existing?.termMonths ?? 360}
          className={`${fieldClass} font-mono`}
        />
      </div>
      <div>
        <label htmlFor="startDate" className="block font-medium text-xs">
          Start date
        </label>
        <input
          id="startDate"
          name="startDate"
          type="date"
          required
          defaultValue={existing?.startDate ?? ""}
          className={fieldClass}
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
          {pending ? "Saving…" : existing ? "Update mortgage" : "Save mortgage"}
        </button>
      </div>
    </form>
  );
}
