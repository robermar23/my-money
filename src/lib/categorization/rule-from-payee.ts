import "server-only";

import { db } from "@/db/client.ts";
import { categoryRules } from "@/db/schema/index.ts";
import { normalizePayee } from "@/lib/importers/normalize.ts";
import { eq } from "drizzle-orm";
import { escapeRegexLiteral } from "./match.ts";

/**
 * Create a category rule from a transaction payee so future matching
 * transactions auto-categorize (the "do this for all of them" lever, P8-08/09).
 *
 * The pattern is the normalized payee (store numbers stripped) escaped to a
 * literal, matched against the transaction `name`. Idempotent: if an identical
 * pattern already exists, this is a no-op — re-categorizing the same merchant
 * with "make rule" won't pile up duplicate rules.
 *
 * @param payee - The raw transaction name to derive the rule from.
 * @param categoryId - The category the rule resolves to.
 * @param categoryName - The category name (written to the legacy text cache).
 * @returns True when a rule was inserted, false when skipped (empty/duplicate).
 */
export async function createRuleFromPayee(
  payee: string,
  categoryId: string,
  categoryName: string,
): Promise<boolean> {
  const pattern = escapeRegexLiteral(normalizePayee(payee));
  if (pattern.length === 0) return false;

  const [existing] = await db
    .select({ id: categoryRules.id })
    .from(categoryRules)
    .where(eq(categoryRules.pattern, pattern))
    .limit(1);
  if (existing) return false;

  await db.insert(categoryRules).values({
    pattern,
    flags: "i",
    field: "name",
    category: categoryName,
    categoryId,
    priority: 100,
  });
  return true;
}
