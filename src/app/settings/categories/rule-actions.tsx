"use client";

import { useTransition } from "react";
import { deleteRuleAction, recategorizeAllAction, toggleRuleAction } from "./actions.ts";

export function ToggleRule({
  ruleId,
  enabled,
}: {
  ruleId: string;
  enabled: boolean;
}): React.JSX.Element {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(() => toggleRuleAction(ruleId, !enabled))}
      className="rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      {enabled ? "Disable" : "Enable"}
    </button>
  );
}

export function DeleteRule({ ruleId }: { ruleId: string }): React.JSX.Element {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(() => deleteRuleAction(ruleId))}
      className="rounded border border-red-300 px-2 py-0.5 text-red-700 text-xs hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
    >
      Delete
    </button>
  );
}

export function RecategorizeAllButton(): React.JSX.Element {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const { updated } = await recategorizeAllAction();
          alert(`Re-categorized ${updated} transaction${updated === 1 ? "" : "s"}.`);
        })
      }
      className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
    >
      {pending ? "Re-categorizing…" : "Re-categorize existing transactions"}
    </button>
  );
}
