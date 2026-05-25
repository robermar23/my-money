"use client";

import { useActionState } from "react";
import { type CreateAccountResult, createAccountAction } from "./actions.ts";

const initial: CreateAccountResult = {};

const TYPES = [
  { value: "depository", label: "Cash (checking / savings)" },
  { value: "credit_card", label: "Credit card" },
  { value: "investment", label: "Investment / brokerage / 401k" },
  { value: "crypto_ira", label: "Crypto or metals IRA" },
  { value: "loan", label: "Loan (mortgage)" },
  { value: "property", label: "Property (home)" },
] as const;

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

export function NewAccountForm(): React.JSX.Element {
  const [state, action, pending] = useActionState(createAccountAction, initial);

  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="name" className="block font-medium text-sm">
          Name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={120}
          placeholder="M&T Checking"
          className={fieldClass}
        />
      </div>
      <div>
        <label htmlFor="institution" className="block font-medium text-sm">
          Institution
        </label>
        <input
          id="institution"
          name="institution"
          type="text"
          required
          maxLength={120}
          placeholder="M&T Bank"
          className={fieldClass}
        />
      </div>
      <div>
        <label htmlFor="type" className="block font-medium text-sm">
          Type
        </label>
        <select id="type" name="type" required className={fieldClass}>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="currency" className="block font-medium text-sm">
          Currency
        </label>
        <input
          id="currency"
          name="currency"
          type="text"
          defaultValue="USD"
          maxLength={3}
          minLength={3}
          className={fieldClass}
        />
      </div>
      {state.error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-red-700 text-sm dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-zinc-900 px-4 py-2 font-medium text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {pending ? "Creating…" : "Create account"}
      </button>
    </form>
  );
}
