"use client";

import { useActionState } from "react";
import { type ChangePasswordState, changePasswordAction } from "./actions.ts";

const initial: ChangePasswordState = {};

const inputClass =
  "mt-1 w-full max-w-xs rounded-md border border-zinc-300 px-3 py-1.5 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

/** The change-password form (PLAN19 P19-33(b)). No field is ever pre-filled. */
export function PasswordForm(): React.JSX.Element {
  const [state, action, pending] = useActionState(changePasswordAction, initial);

  return (
    <form action={action} className="mt-3 space-y-3 text-sm">
      <div>
        <label htmlFor="current" className="block text-zinc-500">
          Current password
        </label>
        <input
          id="current"
          name="current"
          type="password"
          required
          autoComplete="current-password"
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="next" className="block text-zinc-500">
          New password
        </label>
        <input
          id="next"
          name="next"
          type="password"
          required
          autoComplete="new-password"
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="confirm" className="block text-zinc-500">
          New password again
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          required
          autoComplete="new-password"
          className={inputClass}
        />
      </div>
      {state.error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-red-700 dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      ) : null}
      {state.changed ? (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          Password changed. Every other browser has been signed out.
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        {pending ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}
