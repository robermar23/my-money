"use client";

import type { CategoryOption } from "@/components/category-picker.tsx";
import type { Transaction } from "@/db/schema/index.ts";
import { Money } from "@/lib/money/money.ts";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import { type ActionResult, deleteTransactionAction, updateTransactionAction } from "./actions.ts";
import { CategoryCell } from "./category-cell.tsx";

const initial: ActionResult = {};

const fieldClass =
  "w-full rounded-md border border-zinc-300 px-2 py-1 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

interface Props {
  readonly accountId: string;
  readonly accountCurrency: string;
  readonly flipSign: boolean;
  readonly txn: Transaction;
  readonly categories: readonly CategoryOption[];
}

/**
 * P7-10 — A single transaction row with inline edit + delete controls.
 *
 * Manual/imported rows get an Edit disclosure (date / payee / memo / amount) and
 * a Delete button. Plaid-sourced rows hide Edit (the sync is authoritative) and
 * note that a delete re-appears on the next sync. The category stays editable
 * for every source via {@link CategoryCell}.
 */
export function TransactionRow({
  accountId,
  accountCurrency,
  flipSign,
  txn,
  categories,
}: Props): React.JSX.Element {
  const router = useRouter();
  const isPlaid = txn.source === "plaid";
  const [editing, setEditing] = useState(false);
  const [deleting, startDelete] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const updateBound = updateTransactionAction.bind(null, accountId, txn.id);
  const [state, action, pending] = useActionState(updateBound, initial);

  // Close the inline form and refresh once an edit succeeds.
  useEffect(() => {
    if (state.ok) {
      setEditing(false);
      router.refresh();
    }
  }, [state.ok, router]);

  function onDelete(): void {
    const msg = isPlaid
      ? "Delete this transaction? It will re-appear on the next bank sync."
      : "Delete this transaction? This can't be undone.";
    if (!window.confirm(msg)) return;
    setDeleteError(null);
    startDelete(async () => {
      const res = await deleteTransactionAction(accountId, txn.id);
      if (res.error) setDeleteError(res.error);
      else router.refresh();
    });
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={5} className="py-2">
          <form action={action} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <input name="postedAt" type="date" defaultValue={txn.postedAt} className={fieldClass} />
            <input
              name="name"
              type="text"
              required
              defaultValue={txn.name}
              placeholder="Payee"
              aria-label="Payee"
              className={`${fieldClass} sm:col-span-2`}
            />
            <input
              name="memo"
              type="text"
              defaultValue={txn.memo ?? ""}
              placeholder="Memo"
              aria-label="Memo"
              className={fieldClass}
            />
            <input
              name="amount"
              type="text"
              inputMode="decimal"
              required
              defaultValue={txn.amount}
              placeholder="-12.34"
              aria-label="Amount (stored sign: positive = money in)"
              className={`${fieldClass} font-mono`}
            />
            {state.error && (
              <p className="col-span-full rounded-md bg-red-50 px-3 py-1.5 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
                {state.error}
              </p>
            )}
            <div className="col-span-full flex items-center gap-2">
              <button
                type="submit"
                disabled={pending}
                className="rounded-md bg-zinc-900 px-3 py-1 font-medium text-white text-xs hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {pending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-md border border-zinc-300 px-3 py-1 text-xs dark:border-zinc-700"
              >
                Cancel
              </button>
              <span className="text-[11px] text-zinc-400">
                Amount uses the stored sign: positive = money in, negative = money out.
              </span>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  const displayAmount = flipSign
    ? Money.fromString(txn.amount, accountCurrency).negate()
    : Money.fromString(txn.amount, accountCurrency);

  return (
    <tr>
      <td className="py-1.5 font-mono">{txn.postedAt}</td>
      <td className="py-1.5">
        <div>{txn.name}</div>
        {txn.memo && <div className="text-xs text-zinc-500">{txn.memo}</div>}
      </td>
      <td className="py-1.5">
        <CategoryCell
          accountId={accountId}
          transactionId={txn.id}
          currentId={txn.categoryId}
          currentName={txn.category}
          categories={categories}
        />
      </td>
      <td
        className={`py-1.5 text-right font-mono ${
          displayAmount.isNegative() ? "text-red-700 dark:text-red-300" : ""
        }`}
      >
        {displayAmount.format()}
      </td>
      <td className="py-1.5 text-right">
        <div className="flex items-center justify-end gap-2">
          {isPlaid ? (
            <span className="text-[11px] text-zinc-400" title="Synced from your bank">
              synced
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs text-zinc-600 hover:underline dark:text-zinc-400"
            >
              Edit
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="text-red-600 text-xs hover:underline disabled:opacity-50 dark:text-red-400"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
        {deleteError && (
          <div className="mt-0.5 text-red-600 text-xs dark:text-red-400">{deleteError}</div>
        )}
      </td>
    </tr>
  );
}
