import { requireUser } from "@/lib/auth/require-user.ts";
import { listCategoriesWithGroups } from "@/lib/categories/queries.ts";
import { listUncategorizedByPayee } from "@/lib/transactions/queries.ts";
import type { Metadata } from "next";
import Link from "next/link";
import { ReviewClient } from "./review-client.tsx";

export const metadata: Metadata = { title: "Review uncategorized" };

/**
 * Bulk "review uncategorized" queue (P8-09). Uncategorized transactions across
 * all accounts, grouped by normalized payee, so the owner can categorize each
 * merchant once — optionally creating a rule so it never reappears.
 */
export default async function ReviewPage(): Promise<React.JSX.Element> {
  await requireUser();
  const [groups, categoryData] = await Promise.all([
    listUncategorizedByPayee(),
    listCategoriesWithGroups(),
  ]);

  const categories = categoryData.categories.map((c) => ({
    id: c.id,
    name: c.name,
    groupName: c.groupName,
    kind: c.kind,
  }));

  const totalTxns = groups.reduce((acc, g) => acc + g.count, 0);

  return (
    <main className="mx-auto max-w-3xl p-6">
      <Link href="/settings/categories" className="text-sm text-zinc-500 hover:underline">
        ← Categories
      </Link>
      <h1 className="mt-2 font-semibold text-2xl tracking-tight">Review uncategorized</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {totalTxns} uncategorized transaction{totalTxns === 1 ? "" : "s"} across {groups.length}{" "}
        payee{groups.length === 1 ? "" : "s"}. Pick a category per payee and categorize them all at
        once.
      </p>

      <ReviewClient groups={groups} categories={categories} />
    </main>
  );
}
