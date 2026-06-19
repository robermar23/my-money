import "server-only";

import { db } from "@/db/client.ts";
import { categories, categoryGroups, categoryRules, transactions } from "@/db/schema/index.ts";
import { isNotNull, sql } from "drizzle-orm";
import { seedDefaultCategoriesAndRulesIfEmpty } from "./seed.ts";

/**
 * One-shot, idempotent backfill from the legacy free-text `category` columns to
 * the structured `categories` model (ADR-018, P8-04).
 *
 * Strategy (never destroys data — CLAUDE.md: historical financial data is the
 * product):
 *   1. Ensure the seed groups + categories exist (so known names map to the
 *      curated taxonomy with correct `kind`).
 *   2. For every distinct non-null free-text value on `transactions` and
 *      `category_rules` that isn't already a category (case-insensitive), create
 *      a leaf under the *Other* group with `kind='expense'`. Unknown values are
 *      preserved, never dropped.
 *   3. Link `transactions.category_id` by case-insensitive name match (only
 *      rows still NULL — re-running never re-links or overwrites).
 *   4. Link `category_rules.category_id` the same way.
 *
 * Safe to re-run: steps 2–4 are no-ops once everything is linked. Exposed via
 * `src/worker/run-once.ts` so it runs once post-deploy. Take a `pg_dump` first
 * (docs/BACKUP.md) before running on real data.
 */
export interface BackfillResult {
  readonly groupsCreated: number;
  readonly categoriesCreated: number;
  readonly txnsLinked: number;
  readonly rulesLinked: number;
}

export async function backfillCategories(): Promise<BackfillResult> {
  // 1. Curated seed first, so well-known names land in the right group/kind.
  const seed = await seedDefaultCategoriesAndRulesIfEmpty();

  // 2. Collect distinct free-text values from both tables.
  const [txnCatRows, ruleCatRows, existingCatRows] = await Promise.all([
    db
      .selectDistinct({ name: transactions.category })
      .from(transactions)
      .where(isNotNull(transactions.category)),
    db.selectDistinct({ name: categoryRules.category }).from(categoryRules),
    db.select({ name: categories.name }).from(categories),
  ]);

  const existingLower = new Set(existingCatRows.map((c) => c.name.toLowerCase()));

  // Dedupe wanted names case-insensitively, keeping the first-seen casing.
  const wantedByLower = new Map<string, string>();
  for (const row of [...txnCatRows, ...ruleCatRows]) {
    const raw = row.name?.trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (existingLower.has(lower)) continue;
    if (!wantedByLower.has(lower)) wantedByLower.set(lower, raw);
  }

  let categoriesCreated = 0;
  if (wantedByLower.size > 0) {
    // Unknown legacy values land under "Other" so nothing is lost.
    const [other] = await db
      .select({ id: categoryGroups.id })
      .from(categoryGroups)
      .where(sql`lower(${categoryGroups.name}) = 'other'`)
      .limit(1);

    const newCategories = [...wantedByLower.values()].map((name) => ({
      name,
      kind: "expense" as const,
      groupId: other?.id ?? null,
    }));
    await db.insert(categories).values(newCategories);
    categoriesCreated = newCategories.length;
  }

  // 3. Link transactions by case-insensitive name match (only still-NULL rows).
  const linkedTxns = await db.execute(
    sql`UPDATE transactions AS t
        SET category_id = c.id
        FROM categories AS c
        WHERE lower(t.category) = lower(c.name)
          AND t.category IS NOT NULL
          AND t.category_id IS NULL
        RETURNING t.id`,
  );

  // 4. Link rules the same way.
  const linkedRules = await db.execute(
    sql`UPDATE category_rules AS r
        SET category_id = c.id
        FROM categories AS c
        WHERE lower(r.category) = lower(c.name)
          AND r.category_id IS NULL
        RETURNING r.id`,
  );

  return {
    groupsCreated: seed.groupsInserted,
    categoriesCreated,
    txnsLinked: rowCount(linkedTxns),
    rulesLinked: rowCount(linkedRules),
  };
}

/**
 * postgres-js returns a RETURNING result as an array-like row list; `.length`
 * is the affected-row count. Guard for the rare driver that returns `{ count }`.
 */
function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const count = (result as { count?: number; length?: number })?.count;
  if (typeof count === "number") return count;
  const length = (result as { length?: number })?.length;
  return typeof length === "number" ? length : 0;
}
