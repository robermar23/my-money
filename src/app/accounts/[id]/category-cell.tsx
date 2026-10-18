"use client";

import { type CategoryOption, CategoryPicker } from "@/components/category-picker.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useState, useTransition } from "react";
import { setTransactionCategoryAction } from "./actions.ts";

interface Props {
  readonly accountId: string;
  readonly transactionId: string;
  readonly currentId: string | null;
  readonly currentName: string | null;
  readonly categories: readonly CategoryOption[];
}

/**
 * Inline category editor (ADR-018/P8-08). Clicking the cell opens a managed
 * category picker (grouped, with inline create). A "+ rule" checkbox lets the
 * user also create an auto-categorization rule from this payee in one action.
 */
export function CategoryCell({
  accountId,
  transactionId,
  currentId,
  currentName,
  categories,
}: Props): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [makeRule, setMakeRule] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-left text-xs text-zinc-600 hover:underline dark:text-zinc-400"
      >
        {currentName ?? "Uncategorized"}
      </button>
    );
  }

  function commit(categoryId: string | null): void {
    startTransition(async () => {
      await setTransactionCategoryAction(accountId, transactionId, categoryId, { makeRule });
      setEditing(false);
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <CategoryPicker
          categories={categories}
          value={currentId}
          onChange={commit}
          autoFocus
          disabled={pending}
        />
        <Button type="button" onClick={() => setEditing(false)} variant="secondary" size="xs">
          ✕
        </Button>
      </div>
      <label className="flex items-center gap-1 text-[11px] text-zinc-500">
        <input type="checkbox" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} />
        and make a rule for this payee
      </label>
    </div>
  );
}
