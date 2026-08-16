"use client";

import { ACCOUNT_SUBTYPES, ACCOUNT_TAX_TREATMENTS } from "@/db/schema/accounts.ts";
import { useActionState, useState } from "react";
import { type ActionResult, updateAccountTermsAction } from "./actions.ts";

/**
 * P15-29 — the account-terms form: subtype, APY, CD maturity, tax treatment.
 *
 * Fields are shown CONDITIONALLY BY ACCOUNT TYPE, not all at once. A tax
 * treatment on a checking account and a maturity date on a brokerage are both
 * meaningless, and offering them would invite entries the engine then has to
 * decide whether to believe.
 *
 * Two deliberate refusals in this form:
 *
 *   - **No field is pre-filled with a default.** Blank means "not recorded" and
 *     stays that way until the user says otherwise, because an unset subtype
 *     must remain distinguishable from a deliberately-chosen one (ADR-033 §1).
 *   - **The maturity input only exists when the subtype is CD.** Rather than
 *     rendering it disabled, it is absent — so it cannot submit a stale value
 *     when a matured CD is reclassified as savings.
 *
 * The APY help text carries the unit, because this is the one direction the Zod
 * schema cannot guard: 0.045 typed for 4.5% is a legal 0.045% yield, and a
 * validator that guessed at intent would be worse than one that doesn't.
 */

const initial: ActionResult = {};

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

const SUBTYPE_LABEL: Readonly<Record<(typeof ACCOUNT_SUBTYPES)[number], string>> = {
  checking: "Checking (day-to-day)",
  savings: "Savings",
  money_market: "Money market",
  cd: "CD (certificate of deposit)",
  cash_management: "Cash management",
};

const TAX_TREATMENT_LABEL: Readonly<Record<(typeof ACCOUNT_TAX_TREATMENTS)[number], string>> = {
  taxable: "Taxable (brokerage)",
  tax_deferred: "Tax-deferred (401k / traditional IRA)",
  roth: "Roth",
  hsa: "HSA",
};

interface Props {
  readonly accountId: string;
  /** Drives which fields are offered. */
  readonly accountType: string;
  readonly subtype: string | null;
  readonly apy: string | null;
  readonly maturityDate: string | null;
  readonly taxTreatment: string | null;
}

export function AccountTermsForm({
  accountId,
  accountType,
  subtype,
  apy,
  maturityDate,
  taxTreatment,
}: Props): React.JSX.Element {
  const bound = updateAccountTermsAction.bind(null, accountId);
  const [state, action, pending] = useActionState(bound, initial);
  const [selectedSubtype, setSelectedSubtype] = useState(subtype ?? "");

  const showCashFields = accountType === "depository";
  const showTaxTreatment = accountType === "investment" || accountType === "crypto_ira";

  return (
    <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {showCashFields && (
        <>
          <div>
            <label htmlFor="terms-subtype" className="block font-medium text-xs">
              Account subtype
            </label>
            <select
              id="terms-subtype"
              name="subtype"
              value={selectedSubtype}
              onChange={(e) => setSelectedSubtype(e.target.value)}
              className={fieldClass}
            >
              <option value="">Not set</option>
              {ACCOUNT_SUBTYPES.map((s) => (
                <option key={s} value={s}>
                  {SUBTYPE_LABEL[s]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-zinc-500">
              Separates spending cash from reserve and medium-term savings.
            </p>
          </div>
          <div>
            <label htmlFor="terms-apy" className="block font-medium text-xs">
              APY (%)
            </label>
            <input
              id="terms-apy"
              name="apy"
              type="text"
              inputMode="decimal"
              defaultValue={apy ?? ""}
              placeholder="4.5 for 4.5%"
              className={`${fieldClass} font-mono`}
            />
            <p className="mt-1 text-xs text-zinc-500">
              A percentage, not a fraction — enter <span className="font-mono">4.5</span>, not{" "}
              <span className="font-mono">0.045</span>.
            </p>
          </div>
          {selectedSubtype === "cd" && (
            <div>
              <label htmlFor="terms-maturity" className="block font-medium text-xs">
                Maturity date
              </label>
              <input
                id="terms-maturity"
                name="maturityDate"
                type="date"
                defaultValue={maturityDate ?? ""}
                className={fieldClass}
              />
            </div>
          )}
        </>
      )}

      {showTaxTreatment && (
        <div>
          <label htmlFor="terms-tax" className="block font-medium text-xs">
            Tax treatment
          </label>
          <select
            id="terms-tax"
            name="taxTreatment"
            defaultValue={taxTreatment ?? ""}
            className={fieldClass}
          >
            <option value="">Not set</option>
            {ACCOUNT_TAX_TREATMENTS.map((t) => (
              <option key={t} value={t}>
                {TAX_TREATMENT_LABEL[t]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-zinc-500">
            Used only to order savings priorities. No tax is calculated anywhere in this app.
          </p>
        </div>
      )}

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
          {pending ? "Saving…" : "Save details"}
        </button>
      </div>
    </form>
  );
}
