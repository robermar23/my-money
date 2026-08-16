"use client";

import { CATEGORY_NECESSITIES } from "@/db/schema/categories.ts";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { bulkClassifyAction } from "./category-actions.ts";
import type { ManagedCategory } from "./category-manager.tsx";

/**
 * P15-31 — the bulk "classify unclassified" pass.
 *
 * ── Why a bulk pass is not a nicety ────────────────────────────────────────
 * The emergency-fund target, the needs/wants diagnostic and the reserve figure
 * all size against ESSENTIAL monthly expenses. Every unclassified expense
 * category makes those numbers quietly low, and the app's own honesty rule
 * (ADR-032 consequence 1) means it must then report reduced confidence rather
 * than a confident wrong figure. So the fix for "your guidance is vague" is
 * classifying categories — and classifying thirty of them one click at a time,
 * one page scroll apart, is exactly the chore that never gets finished.
 *
 * This panel shows only what is still unclassified, three buttons wide, and
 * submits the whole batch at once. It disappears when the work is done, which is
 * the point: it is a task, not a permanent control.
 *
 * Selections are held locally until Apply. Nothing is written on a stray click —
 * the same preview-then-confirm posture the importers and budget suggestions
 * use for bulk writes.
 */

const NECESSITY_LABEL: Readonly<Record<(typeof CATEGORY_NECESSITIES)[number], string>> = {
  essential: "Essential",
  discretionary: "Discretionary",
  savings: "Savings",
};

const NECESSITY_HINT: Readonly<Record<(typeof CATEGORY_NECESSITIES)[number], string>> = {
  essential: "You'd still pay this if money got tight — rent, utilities, groceries, insurance.",
  discretionary: "You could cut this back — dining out, subscriptions, travel.",
  savings: "Money you set aside that isn't already a transfer category.",
};

interface Props {
  /** Every non-archived category; the panel filters to unclassified expenses. */
  readonly categories: readonly ManagedCategory[];
}

export function BulkClassify({ categories }: Props): React.JSX.Element | null {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Only expense categories carry a necessity: `kind='transfer'` is excluded
  // from every total by construction (ADR-018), and income has its own axis.
  const unclassified = categories.filter((c) => c.kind === "expense" && c.necessity === null);

  if (unclassified.length === 0) return null;

  const selected = Object.entries(choices).filter(([, necessity]) => necessity !== "");

  function apply(): void {
    setError(null);
    startTransition(async () => {
      const res = await bulkClassifyAction(
        selected.map(([categoryId, necessity]) => ({ categoryId, necessity })),
      );
      if (res.error) {
        setError(res.error);
        return;
      }
      setChoices({});
      router.refresh();
    });
  }

  return (
    <section className="mt-8 rounded-lg border border-amber-300 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-950/20">
      <h2 className="font-medium">
        Classify {unclassified.length} unclassified categor
        {unclassified.length === 1 ? "y" : "ies"}
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
        Marking which spending is essential lets the app size an emergency fund against the bills
        you would still owe, rather than against a month that happened to include a vacation.
        Anything left unclassified is reported as unknown, never guessed.
      </p>

      <dl className="mt-3 space-y-0.5 text-xs text-zinc-500">
        {CATEGORY_NECESSITIES.map((n) => (
          <div key={n} className="flex gap-2">
            <dt className="w-24 shrink-0 font-medium">{NECESSITY_LABEL[n]}</dt>
            <dd>{NECESSITY_HINT[n]}</dd>
          </div>
        ))}
      </dl>

      <ul className="mt-4 divide-y divide-amber-200 dark:divide-amber-900/50">
        {unclassified.map((category) => (
          <li
            key={category.id}
            className="flex flex-wrap items-center justify-between gap-2 py-1.5"
          >
            <span className="text-sm">
              {category.name}
              {category.groupName && (
                <span className="ml-1.5 text-xs text-zinc-500">{category.groupName}</span>
              )}
            </span>
            <div className="flex gap-1.5">
              {CATEGORY_NECESSITIES.map((n) => {
                const active = choices[category.id] === n;
                return (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      setChoices((prev) => ({ ...prev, [category.id]: active ? "" : n }))
                    }
                    className={`rounded border px-2 py-0.5 text-xs ${
                      active
                        ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                        : "border-zinc-300 hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-900"
                    }`}
                  >
                    {NECESSITY_LABEL[n]}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>

      {error && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={pending || selected.length === 0}
        onClick={apply}
        className="mt-4 rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white hover:bg-zinc-800 disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {pending
          ? "Classifying…"
          : selected.length === 0
            ? "Choose a classification above"
            : `Classify ${selected.length} categor${selected.length === 1 ? "y" : "ies"}`}
      </button>
    </section>
  );
}
