"use client";

import { type CategoryOption, CategoryPicker } from "@/components/category-picker.tsx";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { type RuleActionResult, updateRuleAction } from "./actions.ts";
import { DeleteRule, ToggleRule } from "./rule-actions.tsx";

const initial: RuleActionResult = {};

const fieldClass =
  "w-full rounded-md border border-zinc-300 px-2 py-1 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

export interface RuleView {
  readonly id: string;
  readonly priority: number;
  readonly pattern: string;
  readonly flags: string;
  readonly field: string;
  readonly category: string | null;
  readonly categoryId: string | null;
  readonly enabled: boolean;
}

interface Props {
  readonly rule: RuleView;
  readonly categories: readonly CategoryOption[];
}

/**
 * P7-16 — A single category-rule row with an inline Edit form.
 *
 * Display mode shows the rule with Enable/Disable + Delete (existing controls)
 * plus an Edit toggle. Edit mode swaps the row for a form bound to
 * {@link updateRuleAction} (pattern / flags / field / category / priority);
 * previously rules could only be deleted and recreated.
 */
export function RuleRow({ rule, categories }: Props): React.JSX.Element {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [categoryId, setCategoryId] = useState<string | null>(rule.categoryId);
  const [state, action, pending] = useActionState(updateRuleAction, initial);

  // Close the form and refresh once an edit succeeds.
  useEffect(() => {
    if (state.ok) {
      setEditing(false);
      router.refresh();
    }
  }, [state.ok, router]);

  if (editing) {
    return (
      <tr>
        <td colSpan={7} className="py-2">
          <form action={action} className="grid grid-cols-12 items-end gap-2">
            <input type="hidden" name="id" value={rule.id} />
            <input type="hidden" name="categoryId" value={categoryId ?? ""} />
            <div className="col-span-1">
              <label htmlFor={`pri-${rule.id}`} className="block font-medium text-xs">
                Pri
              </label>
              <input
                id={`pri-${rule.id}`}
                name="priority"
                type="number"
                defaultValue={rule.priority}
                className={`${fieldClass} font-mono`}
              />
            </div>
            <div className="col-span-4">
              <label htmlFor={`pattern-${rule.id}`} className="block font-medium text-xs">
                Pattern (JS regex)
              </label>
              <input
                id={`pattern-${rule.id}`}
                name="pattern"
                required
                defaultValue={rule.pattern}
                className={`${fieldClass} font-mono`}
              />
            </div>
            <div className="col-span-1">
              <label htmlFor={`flags-${rule.id}`} className="block font-medium text-xs">
                Flags
              </label>
              <input
                id={`flags-${rule.id}`}
                name="flags"
                defaultValue={rule.flags}
                className={`${fieldClass} font-mono`}
              />
            </div>
            <div className="col-span-2">
              <label htmlFor={`field-${rule.id}`} className="block font-medium text-xs">
                Field
              </label>
              <select
                id={`field-${rule.id}`}
                name="field"
                defaultValue={rule.field}
                className={fieldClass}
              >
                <option value="name">name</option>
                <option value="memo">memo</option>
              </select>
            </div>
            <div className="col-span-4">
              {/* biome-ignore lint/a11y/noLabelWithoutControl: picker renders its own labelled select */}
              <label className="block font-medium text-xs">Category</label>
              <div className="mt-1">
                <CategoryPicker
                  categories={categories}
                  value={categoryId}
                  onChange={setCategoryId}
                />
              </div>
            </div>
            {state.error && (
              <p className="col-span-12 rounded-md bg-red-50 px-3 py-1.5 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
                {state.error}
              </p>
            )}
            <div className="col-span-12 flex items-center gap-2">
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
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="py-1.5 font-mono">{rule.priority}</td>
      <td className="py-1.5 font-mono">{rule.pattern}</td>
      <td className="py-1.5 font-mono">{rule.flags}</td>
      <td className="py-1.5 text-zinc-600 dark:text-zinc-400">{rule.field}</td>
      <td className="py-1.5">{rule.category}</td>
      <td className="py-1.5 text-xs">
        {rule.enabled ? (
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            enabled
          </span>
        ) : (
          <span className="rounded bg-zinc-100 px-2 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            disabled
          </span>
        )}
      </td>
      <td className="py-1.5">
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Edit
          </button>
          <ToggleRule ruleId={rule.id} enabled={rule.enabled} />
          <DeleteRule ruleId={rule.id} />
        </div>
      </td>
    </tr>
  );
}
