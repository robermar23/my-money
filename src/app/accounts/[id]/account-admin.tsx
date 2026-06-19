"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import {
  type ActionResult,
  closeAccountAction,
  deleteAccountAction,
  reopenAccountAction,
  updateAccountAction,
} from "./actions.ts";

/**
 * P7-05 — Account management island for the account detail header.
 *
 * Surfaces three controls: an Edit disclosure (name/institution always; type and
 * currency locked once the account has data), a Close/Reopen toggle, and a hard
 * Delete behind a typed-name confirmation. Delete is blocked for Plaid-linked
 * accounts with a pointer to Disconnect first.
 */

const TYPES = [
  { value: "depository", label: "Cash (checking / savings)" },
  { value: "credit_card", label: "Credit card" },
  { value: "investment", label: "Investment / brokerage / 401k" },
  { value: "crypto_ira", label: "Crypto or metals IRA" },
  { value: "loan", label: "Loan (mortgage)" },
  { value: "property", label: "Property (home)" },
] as const;

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900";

const initial: ActionResult = {};

interface Props {
  readonly accountId: string;
  readonly name: string;
  readonly institution: string;
  readonly type: string;
  readonly currency: string;
  /** True when type/currency are locked (account has transactions/holdings/snapshots). */
  readonly hasData: boolean;
  /** True when the account is closed (archived). */
  readonly closed: boolean;
  /** True when the account is linked to a Plaid Item — blocks hard delete. */
  readonly isPlaidLinked: boolean;
}

export function AccountAdmin({
  accountId,
  name,
  institution,
  type,
  currency,
  hasData,
  closed,
  isPlaidLinked,
}: Props): React.JSX.Element {
  const router = useRouter();
  const updateBound = updateAccountAction.bind(null, accountId);
  const [editState, editAction, editPending] = useActionState(updateBound, initial);

  const [toggling, startToggle] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [confirmText, setConfirmText] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function onToggleClose(): void {
    startToggle(async () => {
      const res = closed
        ? await reopenAccountAction(accountId)
        : await closeAccountAction(accountId);
      if (!res.error) router.refresh();
    });
  }

  function onDelete(): void {
    setDeleteError(null);
    startDelete(async () => {
      const res = await deleteAccountAction(accountId);
      // On success the action redirects to /accounts (no value returned here).
      if (res?.error) setDeleteError(res.error);
    });
  }

  return (
    <div className="mt-4 flex flex-wrap items-start gap-3 text-sm">
      {/* Edit */}
      <details className="w-full rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <summary className="cursor-pointer font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
          Edit account
        </summary>
        <form action={editAction} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="edit-name" className="block font-medium text-xs">
              Name
            </label>
            <input
              id="edit-name"
              name="name"
              type="text"
              required
              maxLength={120}
              defaultValue={name}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor="edit-institution" className="block font-medium text-xs">
              Institution
            </label>
            <input
              id="edit-institution"
              name="institution"
              type="text"
              required
              maxLength={120}
              defaultValue={institution}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor="edit-type" className="block font-medium text-xs">
              Type
            </label>
            <select
              id="edit-type"
              name="type"
              required
              defaultValue={type}
              disabled={hasData}
              className={fieldClass}
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="edit-currency" className="block font-medium text-xs">
              Currency
            </label>
            <input
              id="edit-currency"
              name="currency"
              type="text"
              maxLength={3}
              minLength={3}
              defaultValue={currency}
              disabled={hasData}
              className={fieldClass}
            />
          </div>
          {hasData && (
            <p className="col-span-full text-xs text-zinc-500">
              Clear this account's data to change its type or currency.
            </p>
          )}
          {editState.error && (
            <p className="col-span-full rounded-md bg-red-50 px-3 py-2 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
              {editState.error}
            </p>
          )}
          {editState.note && (
            <p className="col-span-full rounded-md bg-amber-50 px-3 py-2 text-amber-800 text-xs dark:bg-amber-950 dark:text-amber-200">
              {editState.note}
            </p>
          )}
          <div className="col-span-full">
            <button
              type="submit"
              disabled={editPending}
              className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {editPending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </details>

      {/* Close / Reopen */}
      <button
        type="button"
        onClick={onToggleClose}
        disabled={toggling}
        className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        {toggling
          ? closed
            ? "Reopening…"
            : "Closing…"
          : closed
            ? "Reopen account"
            : "Close account"}
      </button>

      {/* Delete */}
      <details className="w-full rounded-lg border border-red-200 p-3 dark:border-red-900">
        <summary className="cursor-pointer font-medium text-red-600 hover:text-red-700 dark:text-red-400">
          Delete account
        </summary>
        {isPlaidLinked ? (
          <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
            This account is linked to a bank connection.{" "}
            <Link href="/settings/connections" className="underline">
              Disconnect it first
            </Link>{" "}
            to delete.
          </p>
        ) : (
          <div className="mt-3">
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              This permanently deletes the account and all its transactions, holdings, and
              snapshots. This can't be undone. Type{" "}
              <span className="font-mono font-medium">{name}</span> to confirm.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={name}
                aria-label="Type the account name to confirm deletion"
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm shadow-sm focus:border-red-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                type="button"
                onClick={onDelete}
                disabled={deleting || confirmText !== name}
                className="rounded-md bg-red-600 px-3 py-1.5 font-medium text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
            {deleteError && (
              <p className="mt-2 text-red-600 text-xs dark:text-red-400">{deleteError}</p>
            )}
          </div>
        )}
      </details>
    </div>
  );
}
