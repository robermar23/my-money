"use server";

import { db } from "@/db/client.ts";
import { categories, transactions } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { createRuleFromPayee } from "@/lib/categorization/rule-from-payee.ts";
import { eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

/**
 * Result of a bulk-categorize action (P8-09). `updated` is the number of
 * transactions repointed; `ruleCreated` is whether a payee rule was added.
 */
export interface BulkCategoryResult {
  error?: string;
  ok?: boolean;
  updated?: number;
  ruleCreated?: boolean;
}

const bulkSchema = z.object({
  txnIds: z.array(z.string().uuid()).min(1, "No transactions selected").max(5000),
  categoryId: z.string().uuid("Invalid category id"),
  makeRule: z.boolean().default(false),
});

/**
 * Categorize a whole group of transactions at once (the "Categorize all N"
 * button on the review queue). Sets `categoryId` + the legacy `category` text
 * cache and stamps `categoryOverriddenAt` (these are explicit human choices, so
 * a later rule re-run must not clobber them).
 *
 * With `makeRule`, derives a rule from the group's payee so the group never
 * reappears in the queue. The payee is read server-side from the first
 * transaction — all rows in a queue group share a normalized payee.
 *
 * @param txnIds - Transaction UUIDs to categorize.
 * @param categoryId - Target category UUID.
 * @param opts.makeRule - When true, also create a rule from the payee.
 * @returns BulkCategoryResult with counts, or `error` on invalid input.
 */
export async function bulkSetCategoryAction(
  txnIds: readonly string[],
  categoryId: string,
  opts?: { makeRule?: boolean },
): Promise<BulkCategoryResult> {
  await requireUser();
  const parsed = bulkSchema.safeParse({
    txnIds,
    categoryId,
    makeRule: opts?.makeRule ?? false,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const [cat] = await db
    .select({ name: categories.name })
    .from(categories)
    .where(eq(categories.id, parsed.data.categoryId))
    .limit(1);
  if (!cat) return { error: "Category not found" };

  const updatedRows = await db
    .update(transactions)
    .set({
      category: cat.name,
      categoryId: parsed.data.categoryId,
      categoryOverriddenAt: new Date(),
    })
    .where(inArray(transactions.id, [...parsed.data.txnIds]))
    .returning({ id: transactions.id, name: transactions.name });

  let ruleCreated = false;
  if (parsed.data.makeRule && updatedRows[0]) {
    ruleCreated = await createRuleFromPayee(updatedRows[0].name, parsed.data.categoryId, cat.name);
  }

  revalidatePath("/analysis/review");
  revalidatePath("/analysis");
  return { ok: true, updated: updatedRows.length, ruleCreated };
}
