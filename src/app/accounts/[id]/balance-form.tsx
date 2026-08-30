"use client";

import { useActionState } from "react";
import { type ActionResult, recordBalanceAction } from "./actions.ts";

const initial: ActionResult = {};

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

interface Props {
  readonly accountId: string;
  /**
   * Drives the field label. True for a liability account, which asks for an
   * **amount owed**; false for everything else, which asks for a balance.
   *
   * Resolved by the *server* page from `isLiabilityAccount`, rather than
   * imported here and evaluated on the client: this is a client component, and
   * importing the sign module would pull `decimal.js` into the account page's
   * bundle to answer one boolean.
   */
  readonly owed: boolean;
}

/**
 * P17-32 — manual balance entry.
 *
 * **The label is not cosmetic** (ADR-042 §3). For a `credit_card` this field
 * asks for an amount owed and `recordBalanceAction` stores it negated, because
 * `account_snapshots.balance` is a net-worth contribution rather than a
 * statement balance. Before this, the field said `Balance` and stored what was
 * typed — so a household reading `$1,234.56` off a Visa statement overstated its
 * net worth by twice that, with no warning anywhere. A future reader must not
 * drop the relabel from a diff as polish: the label is what makes the negation
 * legible, and the two come from the same predicate so they cannot drift.
 */
export function BalanceForm({ accountId, owed }: Props): React.JSX.Element {
  const bound = recordBalanceAction.bind(null, accountId);
  const [state, action, pending] = useActionState(bound, initial);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label htmlFor="balance-date" className="block font-medium text-xs">
          Date
        </label>
        <input
          id="balance-date"
          name="date"
          type="date"
          required
          defaultValue={today}
          className={fieldClass}
        />
      </div>
      <div>
        <label htmlFor="balance-amount" className="block font-medium text-xs">
          {owed ? "Amount owed" : "Balance"}
        </label>
        <input
          id="balance-amount"
          name="balance"
          type="text"
          inputMode="decimal"
          required
          placeholder="1234.56"
          aria-describedby={owed ? "balance-amount-hint" : undefined}
          className={`${fieldClass} font-mono`}
        />
        {owed && (
          <p id="balance-amount-hint" className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Enter what the statement says you owe, as a positive number. If the card is overpaid,
            enter a negative amount.
          </p>
        )}
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
          {pending ? "Saving…" : "Save balance"}
        </button>
      </div>
    </form>
  );
}
