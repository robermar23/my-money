"use client";

import { DEFAULT_CASH_FLOOR, DEFAULT_PROJECTION_HORIZON_DAYS } from "@/lib/cashflow/constants.ts";
import { HORIZON_DAYS_MAX, HORIZON_DAYS_MIN } from "@/lib/schemas/cashflow.ts";
import Link from "next/link";
import { useActionState } from "react";
import { type HouseholdActionResult, saveCashFlowSettingsAction } from "./actions.ts";

/**
 * P16-31 — the two settings the cash-flow projection reads (ADR-038 §4/§5).
 *
 * A separate `<form>` from the profile island above it, submitting through its
 * own action, so saving one never blanks the other's columns on the singleton
 * `household_profile` row.
 *
 * ── Both fields are overrides, and blank is the normal state ───────────────
 * Same posture as every other field on this screen: the defaults live in
 * [constants.ts](../../../lib/cashflow/constants.ts) where a diff can review
 * them, and they render as placeholders rather than as pre-filled values.
 *
 * The cash floor is the one field on this page where blank and zero genuinely
 * differ, and the help text says so: a stored `0.00` is a decision to keep no
 * cushion, and blank is not having decided. The default is zero precisely so the
 * app never quietly shrinks a number the household acts on by an amount nobody
 * chose.
 *
 * Accessibility: every input has a real `<label htmlFor>`, the failure message
 * carries `role="alert"`, and both fields are described by their help text via
 * `aria-describedby` — so the reason a value was rejected is announced rather
 * than merely visible.
 */

const initial: HouseholdActionResult = {};

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

export function CashFlowSettings({
  cashFloor,
  projectionHorizonDays,
}: {
  readonly cashFloor: string;
  readonly projectionHorizonDays: string;
}): React.JSX.Element {
  const [state, action, pending] = useActionState(saveCashFlowSettingsAction, initial);

  return (
    <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="font-medium">Cash-flow projection</h2>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        These two shape the safe-to-spend figure on{" "}
        <Link href="/plan/cashflow" className="underline">
          your cash flow
        </Link>{" "}
        and on the dashboard. Nothing else reads them.
      </p>

      <form action={action} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="cf-floor" className="block font-medium text-xs">
            Cash cushion to keep
          </label>
          <input
            id="cf-floor"
            name="cashFloor"
            type="text"
            inputMode="decimal"
            defaultValue={cashFloor}
            placeholder={`${DEFAULT_CASH_FLOOR} — no cushion`}
            aria-describedby="cf-floor-help"
            className={`${fieldClass} font-mono`}
          />
          <p id="cf-floor-help" className="mt-1 text-xs text-zinc-500">
            Safe to spend is measured down to this balance, not to empty. Setting it to 0 is a
            decision to keep no cushion; leaving it blank means you have not made one, and the app
            does not invent a buffer on your behalf.
          </p>
        </div>

        <div>
          <label htmlFor="cf-horizon" className="block font-medium text-xs">
            How far ahead to project (days)
          </label>
          <input
            id="cf-horizon"
            name="projectionHorizonDays"
            type="text"
            inputMode="numeric"
            defaultValue={projectionHorizonDays}
            placeholder={String(DEFAULT_PROJECTION_HORIZON_DAYS)}
            aria-describedby="cf-horizon-help"
            className={`${fieldClass} font-mono`}
          />
          <p id="cf-horizon-help" className="mt-1 text-xs text-zinc-500">
            Between {HORIZON_DAYS_MIN} and {HORIZON_DAYS_MAX}. The default of{" "}
            {DEFAULT_PROJECTION_HORIZON_DAYS} days covers a full pay cycle and two bill cycles. Much
            past 90 days the everyday-spending estimate dominates the line, so a long horizon looks
            more precise than it is.
          </p>
        </div>

        {state.error && (
          <p
            role="alert"
            className="col-span-full rounded-md bg-red-50 px-3 py-2 text-red-700 text-xs dark:bg-red-950 dark:text-red-300"
          >
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
            {pending ? "Saving…" : "Save projection settings"}
          </button>
        </div>
      </form>
    </section>
  );
}
