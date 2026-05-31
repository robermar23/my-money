"use client";

import { useTransition } from "react";
import { confirmImportAction } from "../../actions.ts";

interface Props {
  readonly accountId: string;
  readonly batchId: string;
  readonly disabled: boolean;
  readonly insertCount: number;
}

export function ConfirmButton({
  accountId,
  batchId,
  disabled,
  insertCount,
}: Props): React.JSX.Element {
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={() => {
        startTransition(async () => {
          await confirmImportAction(accountId, batchId);
        });
      }}
    >
      <button
        type="submit"
        disabled={pending || disabled || insertCount === 0}
        className="rounded-md bg-zinc-900 px-4 py-2 font-medium text-sm text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {pending
          ? "Importing…"
          : insertCount === 0
            ? "Nothing to import"
            : `Confirm import of ${insertCount} transaction${insertCount === 1 ? "" : "s"}`}
      </button>
    </form>
  );
}
