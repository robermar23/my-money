"use client";

import { Button } from "@/components/ui/button.tsx";
import { useActionState } from "react";
import { type ActionResult, saveCreditLineTermsAction } from "./actions.ts";

/**
 * P15-30 — revolving terms for a credit card: APR, limit, minimum payment.
 *
 * ── Why these are typed by hand ────────────────────────────────────────────
 * Plaid's `/liabilities/get` is deliberately not enabled (ADR-033 §6): it is a
 * per-Item subscription-fee product on any paid plan, it needs existing Items
 * re-linked through update mode, and it still would not cover manual accounts
 * the engine has to serve anyway. Three rarely-changing numbers, typed once, is
 * less total effort than all of that.
 *
 * ── Why the entry date is displayed ────────────────────────────────────────
 * The cost of manual terms is that they go stale silently — a promotional APR
 * ends, the card issuer raises the rate, and the payoff plan keeps confidently
 * using last year's number. Showing WHEN the figures were last confirmed is the
 * agreed mitigation (ADR-033 consequence 2). It is not decoration: a payoff
 * ordering built on a two-year-old APR should be read with a two-year-old APR's
 * authority, and the only way a user can apply that discount is if the date is
 * on screen next to the number.
 *
 * Every field may be left blank. A household that knows its limit but not its
 * APR gets working utilization figures while the payoff rung reports
 * `unknown_input` — which is the whole ADR-032 posture: say what is missing,
 * never invent it.
 */

const initial: ActionResult = {};

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

/** How old terms may get before the staleness note stops being reassuring. */
const STALE_AFTER_DAYS = 365;

export interface CreditLineView {
  readonly apr: string | null;
  readonly creditLimit: string | null;
  readonly minimumPayment: string | null;
  readonly minimumPaymentPercent: string | null;
  readonly notes: string | null;
  /** ISO timestamp of the last save. Rendered as the "confirmed on" date. */
  readonly updatedAt: string;
}

interface Props {
  readonly accountId: string;
  readonly existing: CreditLineView | null;
}

/** Whole days between an ISO timestamp and now. */
function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  return Math.floor((Date.now() - then) / 86_400_000);
}

export function CreditLineForm({ accountId, existing }: Props): React.JSX.Element {
  const bound = saveCreditLineTermsAction.bind(null, accountId);
  const [state, action, pending] = useActionState(bound, initial);

  const age = existing ? daysSince(existing.updatedAt) : null;
  const stale = age !== null && age > STALE_AFTER_DAYS;

  return (
    <>
      {existing && (
        <p
          className={`mt-1 text-xs ${
            stale ? "text-amber-700 dark:text-amber-400" : "text-zinc-500"
          }`}
        >
          Last confirmed{" "}
          {new Date(existing.updatedAt).toLocaleDateString("en-US", { dateStyle: "medium" })}
          {stale && " — over a year ago. Check the current APR on a recent statement."}
        </p>
      )}

      <form action={action} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="cl-apr" className="block font-medium text-xs">
            Purchase APR
          </label>
          <input
            id="cl-apr"
            name="apr"
            type="text"
            inputMode="decimal"
            defaultValue={existing?.apr ?? ""}
            placeholder="0.2499 for 24.99%"
            className={`${fieldClass} font-mono`}
          />
          <p className="mt-1 text-xs text-zinc-500">
            A decimal fraction, not the percentage on your statement — enter{" "}
            <span className="font-mono">0.2499</span> for 24.99%.
          </p>
        </div>
        <div>
          <label htmlFor="cl-limit" className="block font-medium text-xs">
            Credit limit
          </label>
          <input
            id="cl-limit"
            name="creditLimit"
            type="text"
            inputMode="decimal"
            defaultValue={existing?.creditLimit ?? ""}
            placeholder="5000.00"
            className={`${fieldClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="cl-min" className="block font-medium text-xs">
            Minimum payment
          </label>
          <input
            id="cl-min"
            name="minimumPayment"
            type="text"
            inputMode="decimal"
            defaultValue={existing?.minimumPayment ?? ""}
            placeholder="35.00"
            className={`${fieldClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="cl-min-pct" className="block font-medium text-xs">
            Minimum payment (% of balance)
          </label>
          <input
            id="cl-min-pct"
            name="minimumPaymentPercent"
            type="text"
            inputMode="decimal"
            defaultValue={existing?.minimumPaymentPercent ?? ""}
            placeholder="2 for 2%"
            className={`${fieldClass} font-mono`}
          />
          <p className="mt-1 text-xs text-zinc-500">
            Set both if your issuer bills the greater of a flat floor and a percentage.
          </p>
        </div>
        <div className="col-span-full">
          <label htmlFor="cl-notes" className="block font-medium text-xs">
            Notes
          </label>
          <input
            id="cl-notes"
            name="notes"
            type="text"
            maxLength={500}
            defaultValue={existing?.notes ?? ""}
            placeholder="0% promo through June 2027"
            className={fieldClass}
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
          <Button
            type="submit"
            variant="commit"
            pending={pending}
            pendingLabel="Saving…"
            succeeded={state.ok === true}
          >
            {existing ? "Update terms" : "Save terms"}
          </Button>
        </div>
      </form>
    </>
  );
}
