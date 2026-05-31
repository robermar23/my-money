"use client";

import { useActionState } from "react";
import { type RuleActionResult, createRuleAction } from "./actions.ts";

const initial: RuleActionResult = {};

const fieldClass =
  "w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

export function NewRuleForm(): React.JSX.Element {
  const [state, action, pending] = useActionState(createRuleAction, initial);

  return (
    <form action={action} className="grid grid-cols-12 items-end gap-2">
      <div className="col-span-4">
        <label htmlFor="pattern" className="block font-medium text-xs">
          Pattern (JS regex)
        </label>
        <input
          id="pattern"
          name="pattern"
          required
          className={`${fieldClass} font-mono`}
          placeholder="STARBUCKS|DUNKIN"
        />
      </div>
      <div className="col-span-2">
        <label htmlFor="flags" className="block font-medium text-xs">
          Flags
        </label>
        <input id="flags" name="flags" defaultValue="i" className={`${fieldClass} font-mono`} />
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
        <label htmlFor="category" className="block font-medium text-xs">
          Category
        </label>
        <input id="category" name="category" required className={fieldClass} placeholder="Coffee" />
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
        <button
          type="submit"
          disabled={pending}
          className="mt-2 rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {pending ? "Adding…" : "Add rule"}
        </button>
      </div>
    </form>
  );
}
