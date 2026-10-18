"use client";

import { type CategoryOption, CategoryPicker } from "@/components/category-picker.tsx";
import { Button } from "@/components/ui/button.tsx";
import type { UncategorizedPayeeGroup } from "@/lib/transactions/queries.ts";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { bulkSetCategoryAction } from "./actions.ts";

interface Props {
  readonly groups: readonly UncategorizedPayeeGroup[];
  readonly categories: readonly CategoryOption[];
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * Client island for the review-uncategorized queue (P8-09). One row per
 * normalized payee: pick a category, optionally make a rule, then categorize the
 * whole group in one action. Categorized groups disappear on success.
 */
export function ReviewClient({ groups, categories }: Props): React.JSX.Element {
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());

  const visible = groups.filter((g) => !done.has(g.payeeKey));

  if (visible.length === 0) {
    return (
      <p className="mt-6 text-sm text-zinc-500">
        Nothing left to review — every transaction is categorized. 🎉
      </p>
    );
  }

  return (
    <ul className="mt-6 divide-y divide-zinc-100 dark:divide-zinc-900">
      {visible.map((g) => (
        <ReviewRow
          key={g.payeeKey}
          group={g}
          categories={categories}
          onDone={() => setDone((prev) => new Set(prev).add(g.payeeKey))}
        />
      ))}
    </ul>
  );
}

function ReviewRow({
  group,
  categories,
  onDone,
}: {
  readonly group: UncategorizedPayeeGroup;
  readonly categories: readonly CategoryOption[];
  readonly onDone: () => void;
}): React.JSX.Element {
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [makeRule, setMakeRule] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function categorize(): void {
    if (!categoryId) {
      setError("Pick a category first");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await bulkSetCategoryAction([...group.txnIds], categoryId, { makeRule });
      if (res.error) {
        setError(res.error);
        return;
      }
      onDone();
      router.refresh();
    });
  }

  return (
    <li data-tour="review-row" className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-sm">{group.sampleName}</div>
        <div className="text-xs text-zinc-500">
          {group.count} txn{group.count === 1 ? "" : "s"} · {usd.format(Number(group.total))}
        </div>
      </div>
      <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} />
      <label data-tour="review-make-rule" className="flex items-center gap-1 text-xs text-zinc-500">
        <input type="checkbox" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} />
        make rule
      </label>
      <Button
        type="button"
        data-tour="review-categorize"
        onClick={categorize}
        variant="commit"
        pending={pending}
        pendingLabel="Saving…"
      >{`Categorize all ${group.count}`}</Button>
      {error && <span className="w-full text-red-600 text-xs dark:text-red-400">{error}</span>}
    </li>
  );
}
