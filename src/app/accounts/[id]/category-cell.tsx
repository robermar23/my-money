"use client";

import { useState, useTransition } from "react";
import { setTransactionCategoryAction } from "./actions.ts";

interface Props {
  readonly accountId: string;
  readonly transactionId: string;
  readonly current: string | null;
  readonly suggestions: readonly string[];
}

/**
 * Inline category editor. Clicking the cell turns it into an input + datalist
 * so the user can either pick an existing category or type a new one.
 */
export function CategoryCell({
  accountId,
  transactionId,
  current,
  suggestions,
}: Props): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const [pending, startTransition] = useTransition();

  const listId = `cat-${transactionId}`;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-left text-xs text-zinc-600 hover:underline dark:text-zinc-400"
      >
        {current ?? "Uncategorized"}
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          await setTransactionCategoryAction(accountId, transactionId, value);
          setEditing(false);
        });
      }}
      className="flex items-center gap-1"
    >
      <input
        list={listId}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-32 rounded border border-zinc-300 px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        // biome-ignore lint/a11y/noAutofocus: opening into an active edit is the point
        autoFocus
        onBlur={() => {
          // Commit on blur; if value === current, no-op.
          if (value !== (current ?? "")) {
            startTransition(async () => {
              await setTransactionCategoryAction(accountId, transactionId, value);
              setEditing(false);
            });
          } else {
            setEditing(false);
          }
        }}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-zinc-900 px-1.5 py-0.5 text-white text-xs disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
      >
        ok
      </button>
    </form>
  );
}
