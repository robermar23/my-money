"use client";

import { type CategoryOption, CategoryPicker } from "@/components/category-picker.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useActionState, useState } from "react";
import { type RuleActionResult, createRuleAction } from "./actions.ts";

const initial: RuleActionResult = {};

const fieldClass =
  "w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

interface Props {
  readonly categories: readonly CategoryOption[];
}

export function NewRuleForm({ categories }: Props): React.JSX.Element {
  const [state, action, pending] = useActionState(createRuleAction, initial);
  const [categoryId, setCategoryId] = useState<string | null>(null);

  return (
    <form action={action} className="grid grid-cols-12 items-end gap-2">
      <input type="hidden" name="categoryId" value={categoryId ?? ""} />
      <div className="col-span-4">
        <label htmlFor="pattern" className="block font-medium text-xs">
          Pattern (JS regex)
        </label>
        <input
          id="pattern"
          name="pattern"
          required
          className={`${fieldClass} font-code`}
          placeholder="STARBUCKS|DUNKIN"
        />
      </div>
      <div className="col-span-2">
        <label htmlFor="flags" className="block font-medium text-xs">
          Flags
        </label>
        <input id="flags" name="flags" defaultValue="i" className={`${fieldClass} font-code`} />
      </div>
      <div className="col-span-2">
        <label htmlFor="field" className="block font-medium text-xs">
          Field
        </label>
        <select id="field" name="field" defaultValue="name" className={fieldClass}>
          <option value="name">name</option>
          <option value="memo">memo</option>
        </select>
      </div>
      <div className="col-span-3">
        {/* biome-ignore lint/a11y/noLabelWithoutControl: picker renders its own labelled select */}
        <label className="block font-medium text-xs">Category</label>
        <div className="mt-1">
          <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} />
        </div>
      </div>
      <div className="col-span-1">
        <label htmlFor="priority" className="block font-medium text-xs">
          Pri
        </label>
        <input
          id="priority"
          name="priority"
          type="number"
          defaultValue="100"
          className={`${fieldClass} font-mono`}
        />
      </div>
      <div className="col-span-12">
        {state.error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
            {state.error}
          </p>
        )}
        <Button
          type="submit"
          variant="commit"
          className="mt-2"
          pending={pending}
          pendingLabel="Adding…"
          succeeded={!state.error}
          successLabel="Added"
        >
          Add rule
        </Button>
      </div>
    </form>
  );
}
