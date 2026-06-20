import { db } from "@/db/client.ts";
import { categoryRules } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { listCategoriesWithGroups } from "@/lib/categories/queries.ts";
import { seedDefaultCategoriesAndRulesIfEmpty } from "@/lib/categorization/seed.ts";
import { asc } from "drizzle-orm";
import Link from "next/link";
import { CategoryManager } from "./category-manager.tsx";
import { DeleteRule, RecategorizeAllButton, ToggleRule } from "./rule-actions.tsx";
import { NewRuleForm } from "./rule-form.tsx";
import { TestPanel } from "./test-panel.tsx";

export default async function CategoriesSettingsPage(): Promise<React.JSX.Element> {
  await requireUser();
  // Auto-seed the defaults the first time the user lands here (idempotent).
  await seedDefaultCategoriesAndRulesIfEmpty();

  const [rules, categoryData] = await Promise.all([
    db
      .select()
      .from(categoryRules)
      .orderBy(asc(categoryRules.priority), asc(categoryRules.createdAt)),
    listCategoriesWithGroups(),
  ]);

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
  }));

  const managedGroups = categoryData.groups.map((g) => ({ id: g.id, name: g.name }));

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="flex items-center justify-between">
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
        <div className="flex items-center gap-2">
          <Link
            href="/analysis/review"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Review uncategorized →
          </Link>
          <RecategorizeAllButton />
        </div>
      </div>

      <CategoryManager categories={managedCategories} groups={managedGroups} />

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
                <td className="py-1.5 font-mono">{r.pattern}</td>
                <td className="py-1.5 font-mono">{r.flags}</td>
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
