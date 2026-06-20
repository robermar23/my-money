"use client";

import { createCategoryAction } from "@/app/settings/categories/category-actions.ts";
import { CATEGORY_KINDS } from "@/lib/schemas/category.ts";
import { useId, useMemo, useState, useTransition } from "react";

/** The minimal category shape a picker needs (ADR-018, P8-08). */
export interface CategoryOption {
  readonly id: string;
  readonly name: string;
  readonly groupName: string | null;
  readonly kind: string;
}

interface Props {
  /** Categories to choose from (already excludes archived). */
  readonly categories: readonly CategoryOption[];
  /** Currently-selected category id, or null for uncategorized. */
  readonly value: string | null;
  /** Called with the new category id (or null when cleared). */
  readonly onChange: (id: string | null) => void;
  /** Show the "— Uncategorized —" option (default true). */
  readonly includeUncategorized?: boolean;
  /** Show the inline "+ New category…" affordance (default true). */
  readonly allowCreate?: boolean;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  readonly className?: string;
}

const CREATE_SENTINEL = "__create__";

const selectClass =
  "rounded border border-zinc-300 px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900";

/**
 * Managed category picker (replaces the free-text datalist, ADR-018/P8-08).
 *
 * Renders a grouped `<select>` of real categories plus an inline
 * "+ New category…" affordance that creates the category via `createCategory`
 * and immediately selects it. Newly-created categories are appended locally so
 * they appear without waiting for the server revalidation to round-trip.
 */
export function CategoryPicker({
  categories,
  value,
  onChange,
  includeUncategorized = true,
  allowCreate = true,
  disabled = false,
  autoFocus = false,
  className,
}: Props): React.JSX.Element {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<string>("expense");
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<readonly CategoryOption[]>([]);
  const [pending, startTransition] = useTransition();
  const nameInputId = useId();

  // Merge server-provided + locally-created categories, de-duped by id.
  const all = useMemo(() => {
    const seen = new Set(categories.map((c) => c.id));
    return [...categories, ...local.filter((c) => !seen.has(c.id))];
  }, [categories, local]);

  // Group for <optgroup> rendering, preserving first-seen group order.
  const grouped = useMemo(() => {
    const byGroup = new Map<string, CategoryOption[]>();
    for (const c of all) {
      const key = c.groupName ?? "Ungrouped";
      const list = byGroup.get(key);
      if (list) list.push(c);
      else byGroup.set(key, [c]);
    }
    return [...byGroup.entries()];
  }, [all]);

  function handleSelect(next: string): void {
    if (next === CREATE_SENTINEL) {
      setCreating(true);
      setError(null);
      return;
    }
    onChange(next === "" ? null : next);
  }

  function submitCreate(): void {
    const name = newName.trim();
    if (name.length === 0) {
      setError("Name is required");
      return;
    }
    startTransition(async () => {
      const fd = new FormData();
      fd.set("name", name);
      fd.set("kind", newKind);
      const result = await createCategoryAction({}, fd);
      if (result.error || !result.createdId) {
        setError(result.error ?? "Could not create category");
        return;
      }
      const created: CategoryOption = {
        id: result.createdId,
        name,
        groupName: null,
        kind: newKind,
      };
      setLocal((prev) => [...prev, created]);
      setCreating(false);
      setNewName("");
      setError(null);
      onChange(created.id);
    });
  }

  if (creating) {
    return (
      <div className={`flex flex-col gap-1 ${className ?? ""}`}>
        <div className="flex items-center gap-1">
          <input
            id={nameInputId}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New category"
            // biome-ignore lint/a11y/noAutofocus: inline-create opens focused by intent
            autoFocus
            className={`w-32 ${selectClass}`}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitCreate();
              } else if (e.key === "Escape") {
                setCreating(false);
                setError(null);
              }
            }}
          />
          <select
            aria-label="Kind"
            value={newKind}
            onChange={(e) => setNewKind(e.target.value)}
            className={selectClass}
          >
            {CATEGORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending}
            onClick={submitCreate}
            className="rounded bg-zinc-900 px-1.5 py-0.5 text-white text-xs disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
          >
            add
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setError(null);
            }}
            className="rounded border border-zinc-300 px-1.5 py-0.5 text-xs dark:border-zinc-700"
          >
            ✕
          </button>
        </div>
        {error && <span className="text-red-600 text-xs dark:text-red-400">{error}</span>}
      </div>
    );
  }

  return (
    <select
      aria-label="Category"
      value={value ?? ""}
      disabled={disabled}
      // biome-ignore lint/a11y/noAutofocus: cell opens into an active edit by intent
      autoFocus={autoFocus}
      onChange={(e) => handleSelect(e.target.value)}
      className={`${selectClass} ${className ?? ""}`}
    >
      {includeUncategorized && <option value="">— Uncategorized —</option>}
      {grouped.map(([groupName, opts]) => (
        <optgroup key={groupName} label={groupName}>
          {opts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      ))}
      {allowCreate && <option value={CREATE_SENTINEL}>+ New category…</option>}
    </select>
  );
}
