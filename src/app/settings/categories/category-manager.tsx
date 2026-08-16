"use client";

import { CATEGORY_NECESSITIES } from "@/db/schema/categories.ts";
import { CATEGORY_KINDS } from "@/lib/schemas/category.ts";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  archiveCategoryAction,
  createCategoryAction,
  createGroupAction,
  mergeCategoryAction,
  setCategoryClassificationAction,
  updateCategoryAction,
} from "./category-actions.ts";

/** Flattened category row for the management table. */
export interface ManagedCategory {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly groupId: string | null;
  readonly groupName: string | null;
  /**
   * Phase 15 (P15-31). `null` = unclassified, and that is a real state the UI
   * shows plainly rather than defaulting away — the guidance engine reports an
   * unclassified share honestly, so the manager has to be able to display one.
   */
  readonly necessity: string | null;
  /** Keep this income category out of the observed take-home baseline. */
  readonly excludedFromBaseline: boolean;
}

export interface ManagedGroup {
  readonly id: string;
  readonly name: string;
}

interface Props {
  readonly categories: readonly ManagedCategory[];
  readonly groups: readonly ManagedGroup[];
  /**
   * Optional case-insensitive name filter (P12-17, the categories `?q=` filter).
   * Narrows the *displayed rows* only — the full `categories` list still backs
   * the "Merge into…" dropdowns so every category stays a valid merge target.
   */
  readonly filter?: string;
}

const inputClass =
  "rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

/**
 * Categories & Groups management (P8-10) — the "don't make me go to a separate
 * page just to add a category" fix from IDEAS2.md. Create/rename/regroup/rekind,
 * archive (soft-delete), and merge categories (to fold backfilled duplicates)
 * all live above the rules table.
 */
export function CategoryManager({ categories, groups, filter }: Props): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const needle = filter?.trim().toLowerCase() ?? "";
  const visible = needle
    ? categories.filter((c) => c.name.toLowerCase().includes(needle))
    : categories;

  function run(fn: () => Promise<{ error?: string }>): void {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className="mt-8">
      <h2 className="font-medium">
        Categories &amp; groups{" "}
        {needle ? `(${visible.length} of ${categories.length})` : `(${categories.length})`}
      </h2>
      <p className="mt-1 text-sm text-zinc-500">
        Add, rename, regroup, set income/expense/transfer, archive, or merge categories. Rules below
        resolve to these.
      </p>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        <span className="font-medium">Necessity</span> is a separate question from kind: kind
        decides what counts as spend, necessity decides what you would still pay if money got tight.
        It sizes the emergency-fund target and the needs/wants split.
      </p>

      {error && (
        <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-6">
        <NewCategoryForm groups={groups} disabled={pending} onRun={run} />
        <NewGroupForm disabled={pending} onRun={run} />
      </div>

      <table className="mt-6 w-full text-sm">
        <thead className="text-left text-xs text-zinc-500 uppercase">
          <tr>
            <th className="py-2">Name</th>
            <th className="py-2">Group</th>
            <th className="py-2">Kind</th>
            <th className="py-2">Necessity</th>
            <th className="py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {visible.map((c) => (
            <CategoryRow
              key={c.id}
              category={c}
              groups={groups}
              categories={categories}
              disabled={pending}
              onRun={run}
            />
          ))}
          {needle && visible.length === 0 && (
            <tr>
              <td colSpan={5} className="py-3 text-sm text-zinc-500">
                No categories match “{filter}”.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function NewCategoryForm({
  groups,
  disabled,
  onRun,
}: {
  readonly groups: readonly ManagedGroup[];
  readonly disabled: boolean;
  readonly onRun: (fn: () => Promise<{ error?: string }>) => void;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("expense");
  const [groupId, setGroupId] = useState("");

  function submit(): void {
    if (name.trim().length === 0) return;
    onRun(async () => {
      const fd = new FormData();
      fd.set("name", name);
      fd.set("kind", kind);
      fd.set("groupId", groupId);
      const res = await createCategoryAction({}, fd);
      if (!res.error) setName("");
      return res;
    });
  }

  return (
    <div className="flex items-end gap-2">
      <div>
        <span className="block font-medium text-xs">New category</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Pharmacy"
          className={`mt-1 ${inputClass}`}
        />
      </div>
      <select
        aria-label="Kind"
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        className={inputClass}
      >
        {CATEGORY_KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <select
        aria-label="Group"
        value={groupId}
        onChange={(e) => setGroupId(e.target.value)}
        className={inputClass}
      >
        <option value="">No group</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={disabled}
        onClick={submit}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
      >
        Add
      </button>
    </div>
  );
}

function NewGroupForm({
  disabled,
  onRun,
}: {
  readonly disabled: boolean;
  readonly onRun: (fn: () => Promise<{ error?: string }>) => void;
}): React.JSX.Element {
  const [name, setName] = useState("");

  function submit(): void {
    if (name.trim().length === 0) return;
    onRun(async () => {
      const fd = new FormData();
      fd.set("name", name);
      const res = await createGroupAction({}, fd);
      if (!res.error) setName("");
      return res;
    });
  }

  return (
    <div className="flex items-end gap-2">
      <div>
        <span className="block font-medium text-xs">New group</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Subscriptions"
          className={`mt-1 ${inputClass}`}
        />
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={submit}
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
      >
        Add group
      </button>
    </div>
  );
}

function CategoryRow({
  category,
  groups,
  categories,
  disabled,
  onRun,
}: {
  readonly category: ManagedCategory;
  readonly groups: readonly ManagedGroup[];
  readonly categories: readonly ManagedCategory[];
  readonly disabled: boolean;
  readonly onRun: (fn: () => Promise<{ error?: string }>) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [kind, setKind] = useState(category.kind);
  const [groupId, setGroupId] = useState(category.groupId ?? "");
  const [mergeId, setMergeId] = useState("");

  function save(): void {
    onRun(async () => {
      const fd = new FormData();
      fd.set("id", category.id);
      fd.set("name", name);
      fd.set("kind", kind);
      fd.set("groupId", groupId);
      const res = await updateCategoryAction({}, fd);
      if (!res.error) setEditing(false);
      return res;
    });
  }

  if (editing) {
    return (
      <tr>
        <td className="py-1.5">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </td>
        <td className="py-1.5">
          <select
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className={inputClass}
          >
            <option value="">No group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </td>
        <td className="py-1.5">
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputClass}>
            {CATEGORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </td>
        {/* Necessity is set inline, not through this form — see NecessityCell. */}
        <td className="py-1.5 text-xs text-zinc-400">—</td>
        <td className="py-1.5">
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              disabled={disabled}
              onClick={save}
              className="rounded bg-zinc-900 px-2 py-0.5 text-white text-xs disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700"
            >
              Cancel
            </button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="py-1.5">{category.name}</td>
      <td className="py-1.5 text-zinc-600 dark:text-zinc-400">{category.groupName ?? "—"}</td>
      <td className="py-1.5 text-zinc-600 dark:text-zinc-400">{category.kind}</td>
      <td className="py-1.5">
        <NecessityCell category={category} disabled={disabled} onRun={onRun} />
      </td>
      <td className="py-1.5">
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <select
            aria-label={`Merge ${category.name} into`}
            value={mergeId}
            onChange={(e) => setMergeId(e.target.value)}
            className={`${inputClass} text-xs`}
          >
            <option value="">Merge into…</option>
            {categories
              .filter((c) => c.id !== category.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <button
            type="button"
            disabled={disabled || mergeId === ""}
            onClick={() => onRun(() => mergeCategoryAction(category.id, mergeId))}
            className="rounded border border-zinc-300 px-2 py-0.5 text-xs disabled:opacity-40 dark:border-zinc-700"
          >
            Merge
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700"
          >
            Edit
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRun(() => archiveCategoryAction(category.id, true))}
            className="rounded border border-red-300 px-2 py-0.5 text-red-700 text-xs disabled:opacity-50 dark:border-red-800 dark:text-red-300"
          >
            Archive
          </button>
        </div>
      </td>
    </tr>
  );
}

/**
 * The inline necessity / baseline-exclusion control for one category row
 * (P15-31).
 *
 * Which control appears is decided by `kind`, because the two axes are
 * orthogonal but not simultaneously meaningful:
 *
 *   - **expense** → a necessity select. This is what sizes the emergency fund
 *     and the needs/wants split.
 *   - **income** → the `excluded_from_baseline` toggle. Observed take-home is
 *     the sum of income categories (ADR-034 §1), and a one-off — a tax refund, a
 *     reimbursement, the sale of a car — inflates it in a way that quietly
 *     inflates every benchmark measured against it. Excluding it is the
 *     auditable alternative to a hidden outlier filter.
 *   - **transfer** → neither. Transfers are excluded from every total by
 *     construction (ADR-018); classifying one would be classifying a number
 *     nothing reads.
 *
 * "Unclassified" is a first-class option, not an absence: a user who
 * mis-classified needs the way back, and the honest unclassified share depends
 * on that state being reachable.
 */
function NecessityCell({
  category,
  disabled,
  onRun,
}: {
  readonly category: ManagedCategory;
  readonly disabled: boolean;
  readonly onRun: (fn: () => Promise<{ error?: string }>) => void;
}): React.JSX.Element {
  if (category.kind === "income") {
    return (
      <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
        <input
          type="checkbox"
          checked={category.excludedFromBaseline}
          disabled={disabled}
          onChange={(e) =>
            onRun(() =>
              setCategoryClassificationAction(category.id, {
                excludedFromBaseline: e.target.checked,
              }),
            )
          }
        />
        Exclude from take-home
      </label>
    );
  }

  if (category.kind !== "expense") {
    return <span className="text-xs text-zinc-400">n/a</span>;
  }

  return (
    <select
      aria-label={`Necessity for ${category.name}`}
      value={category.necessity ?? ""}
      disabled={disabled}
      onChange={(e) =>
        onRun(() => setCategoryClassificationAction(category.id, { necessity: e.target.value }))
      }
      className={`${inputClass} text-xs ${
        category.necessity === null ? "text-amber-700 dark:text-amber-400" : ""
      }`}
    >
      <option value="">Unclassified</option>
      {CATEGORY_NECESSITIES.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}
