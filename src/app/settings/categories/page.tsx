import { SearchInput } from "@/components/search-input.tsx";
import { buttonClass } from "@/components/ui/button-styles.ts";
import { db } from "@/db/client.ts";
import { categoryRules } from "@/db/schema/index.ts";
import { essentialMonthlyBaseline } from "@/lib/advice/essential-expenses.ts";
import { resolveRange } from "@/lib/analytics/range.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { listCategoriesWithGroups } from "@/lib/categories/queries.ts";
import { seedDefaultCategoriesAndRulesIfEmpty } from "@/lib/categorization/seed.ts";
import { asc } from "drizzle-orm";
import Link from "next/link";
import { BulkClassify } from "./bulk-classify.tsx";
import { CategoryManager } from "./category-manager.tsx";
import { DeleteRule, RecategorizeAllButton, ToggleRule } from "./rule-actions.tsx";
import { NewRuleForm } from "./rule-form.tsx";
import { TestPanel } from "./test-panel.tsx";

interface CategoriesSettingsPageProps {
  readonly searchParams?: Promise<{ q?: string }>;
}

export default async function CategoriesSettingsPage(
  props: CategoriesSettingsPageProps,
): Promise<React.JSX.Element> {
  await requireUser();
  const search = (await props.searchParams) ?? {};
  const query = search.q?.trim() ?? "";
  // Auto-seed the defaults the first time the user lands here (idempotent).
  await seedDefaultCategoriesAndRulesIfEmpty();

  // P15-31 — the unclassified-share nudge reads the SAME function the guidance
  // baseline does (P15-09), deliberately. A second query computed here could
  // drift, and the user would then classify categories until this page reported
  // 0% while the plan still reported 18% — which is precisely the kind of
  // self-contradiction that makes a whole feature untrustworthy.
  const spendRange = resolveRange({ range: "12m" });

  const [rules, categoryData, baseline] = await Promise.all([
    db
      .select()
      .from(categoryRules)
      .orderBy(asc(categoryRules.priority), asc(categoryRules.createdAt)),
    listCategoriesWithGroups(),
    essentialMonthlyBaseline({ from: spendRange.from, to: spendRange.to }),
  ]);

  const unclassifiedPct = Math.round(baseline.unclassifiedShare * 100);

  const categoryOptions = categoryData.categories.map((c) => ({
    id: c.id,
    name: c.name,
    groupName: c.groupName,
    kind: c.kind,
  }));

  const managedCategories = categoryData.categories.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    groupId: c.groupId,
    groupName: c.groupName,
    necessity: c.necessity,
    excludedFromBaseline: c.excludedFromBaseline,
  }));

  const managedGroups = categoryData.groups.map((g) => ({ id: g.id, name: g.name }));

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/" className="text-sm text-zinc-500 hover:underline">
            ← Dashboard
          </Link>
          <h1 className="mt-2 font-semibold text-2xl tracking-tight">Categories</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Manage your category taxonomy and the regex rules that auto-categorize incoming
            transactions. First match (lowest priority number) wins. Manual overrides are preserved
            across re-runs.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/analysis/review" className={buttonClass({ variant: "secondary" })}>
            Review uncategorized →
          </Link>
          <RecategorizeAllButton />
        </div>
      </div>

      <div className="mt-6">
        <SearchInput
          placeholder="Filter categories by name…"
          label="Filter categories"
          className="max-w-sm"
        />
      </div>

      {unclassifiedPct > 0 && (
        <p className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800 text-sm dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <span className="font-medium">{unclassifiedPct}% of the last 12 months of spending</span>{" "}
          isn't classified as essential or discretionary. Any emergency-fund target or needs/wants
          split is low by roughly that much, and the app says so rather than guessing.
        </p>
      )}

      <BulkClassify categories={managedCategories} />

      <CategoryManager categories={managedCategories} groups={managedGroups} filter={query} />

      <section className="mt-10">
        <h2 className="font-medium">Rules ({rules.length})</h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs text-zinc-500 uppercase">
            <tr>
              <th className="py-2">Pri</th>
              <th className="py-2">Pattern</th>
              <th className="py-2">Flags</th>
              <th className="py-2">Field</th>
              <th className="py-2">Category</th>
              <th className="py-2">Status</th>
              <th className="py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {rules.map((r) => (
              <tr key={r.id}>
                <td className="py-1.5 font-mono">{r.priority}</td>
                <td className="py-1.5 font-code">{r.pattern}</td>
                <td className="py-1.5 font-code">{r.flags}</td>
                <td className="py-1.5 text-zinc-600 dark:text-zinc-400">{r.field}</td>
                <td className="py-1.5">{r.category}</td>
                <td className="py-1.5 text-xs">
                  {r.enabled ? (
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
                    <ToggleRule ruleId={r.id} enabled={r.enabled} />
                    <DeleteRule ruleId={r.id} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="font-medium">Add rule</h2>
        <div className="mt-3">
          <NewRuleForm categories={categoryOptions} />
        </div>
      </section>

      <TestPanel />
    </main>
  );
}
