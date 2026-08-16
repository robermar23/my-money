import "server-only";

import { db } from "@/db/client.ts";
import type { CategoryNecessity } from "@/db/schema/categories.ts";
import {
  type Category,
  type CategoryGroup,
  categories,
  categoryGroups,
  categoryRules,
  transactions,
} from "@/db/schema/index.ts";
import type {
  CreateCategoryInput,
  CreateGroupInput,
  UpdateCategoryInput,
} from "@/lib/schemas/category.ts";
import { asc, eq, isNull, sql } from "drizzle-orm";

/** A leaf category joined with its (optional) group's display fields. */
export interface CategoryWithGroup extends Category {
  readonly groupName: string | null;
  readonly groupSortOrder: number | null;
}

export interface CategoriesAndGroups {
  readonly groups: readonly CategoryGroup[];
  readonly categories: readonly CategoryWithGroup[];
}

/**
 * List all groups + categories for management UIs and pickers.
 *
 * @param opts.includeArchived - When false (default), archived categories are
 *   omitted (they stay valid for historical rows but drop from pickers).
 * @returns Groups (sorted) and categories (sorted by group then sortOrder).
 */
export async function listCategoriesWithGroups(opts?: {
  includeArchived?: boolean;
}): Promise<CategoriesAndGroups> {
  const includeArchived = opts?.includeArchived ?? false;

  const groups = await db
    .select()
    .from(categoryGroups)
    .orderBy(asc(categoryGroups.sortOrder), asc(categoryGroups.name));

  const baseQuery = db
    .select({
      id: categories.id,
      groupId: categories.groupId,
      name: categories.name,
      kind: categories.kind,
      // Phase 15: `necessity` is orthogonal to `kind` (see categories.ts) and
      // feeds the essential-expense baseline; `excludedFromBaseline` keeps a
      // category out of observed net income. Both are surfaced in the manager.
      necessity: categories.necessity,
      excludedFromBaseline: categories.excludedFromBaseline,
      color: categories.color,
      sortOrder: categories.sortOrder,
      archivedAt: categories.archivedAt,
      createdAt: categories.createdAt,
      updatedAt: categories.updatedAt,
      groupName: categoryGroups.name,
      groupSortOrder: categoryGroups.sortOrder,
    })
    .from(categories)
    .leftJoin(categoryGroups, eq(categories.groupId, categoryGroups.id))
    .orderBy(
      asc(sql`coalesce(${categoryGroups.sortOrder}, 999)`),
      asc(categories.sortOrder),
      asc(categories.name),
    );

  const rows = includeArchived
    ? await baseQuery
    : await baseQuery.where(isNull(categories.archivedAt));

  return { groups, categories: rows };
}

/**
 * Fetch a single category by id.
 *
 * @param id - Category UUID.
 * @returns The category, or null if not found.
 */
export async function getCategory(id: string): Promise<Category | null> {
  const [row] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
  return row ?? null;
}

/**
 * Create a category. Relies on the `categories_name_lower_unique` index to
 * reject case-insensitive duplicates; the caller (server action) translates the
 * unique-violation into a friendly message.
 *
 * @param input - Validated create input.
 * @returns The inserted category.
 */
export async function createCategory(input: CreateCategoryInput): Promise<Category> {
  const [row] = await db
    .insert(categories)
    .values({
      name: input.name,
      kind: input.kind,
      groupId: input.groupId ? input.groupId : null,
      color: input.color ? input.color : null,
    })
    .returning();
  if (!row) throw new Error("createCategory: insert returned no row");
  return row;
}

/**
 * Update a category — any subset of name/kind/group/color. Archive/unarchive is
 * a separate call (`archiveCategory`).
 *
 * @param input - Validated update input (must include `id`).
 * @returns The updated category, or null if the id didn't exist.
 */
export async function updateCategory(input: UpdateCategoryInput): Promise<Category | null> {
  const patch: Partial<typeof categories.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.groupId !== undefined) patch.groupId = input.groupId ? input.groupId : null;
  if (input.color !== undefined) patch.color = input.color ? input.color : null;

  const [row] = await db
    .update(categories)
    .set(patch)
    .where(eq(categories.id, input.id))
    .returning();
  return row ?? null;
}

/**
 * Set one category's Phase 15 classification (P15-31, ADR-033 §2).
 *
 * Kept separate from {@link updateCategory} on purpose. That function edits what
 * a category IS (its name, group, kind); this one edits what the guidance engine
 * should DO with it. They are also reached from different controls — a rename is
 * an explicit edit-and-save, while necessity is a one-click inline change — and
 * folding them together would mean every inline classification round-tripped a
 * name through a form that could fail its own uniqueness check.
 *
 * `necessity: null` is a supported value, not a no-op: it returns a category to
 * unclassified, which a user who mis-classified needs, and which the honest
 * unclassified-share figure depends on being reachable.
 *
 * @param id - Category UUID.
 * @param patch.necessity - The classification, or `null` for unclassified.
 * @param patch.excludedFromBaseline - Keep this category out of observed net
 *   income (ADR-034 §1). Only meaningful on `kind='income'` rows.
 * @returns The updated category, or null if the id didn't exist.
 */
export async function setCategoryClassification(
  id: string,
  patch: {
    readonly necessity?: CategoryNecessity | null;
    readonly excludedFromBaseline?: boolean;
  },
): Promise<Category | null> {
  const values: Partial<typeof categories.$inferInsert> = { updatedAt: new Date() };
  if (patch.necessity !== undefined) values.necessity = patch.necessity;
  if (patch.excludedFromBaseline !== undefined) {
    values.excludedFromBaseline = patch.excludedFromBaseline;
  }

  const [row] = await db.update(categories).set(values).where(eq(categories.id, id)).returning();
  return row ?? null;
}

/**
 * Apply a batch of classifications in one transaction (P15-31, the bulk pass).
 *
 * Transactional, unlike the budget-suggestion apply: those are independent
 * per-category upserts where a partial result is still useful, whereas this is
 * one editing session over a taxonomy the user reviewed as a whole. Landing half
 * of it would leave an unclassified share the user believes they just fixed.
 *
 * @param assignments - `(categoryId, necessity)` pairs; `null` clears.
 * @returns How many categories were updated.
 */
export async function bulkSetNecessity(
  assignments: readonly {
    readonly categoryId: string;
    readonly necessity: CategoryNecessity | null;
  }[],
): Promise<number> {
  if (assignments.length === 0) return 0;
  await db.transaction(async (tx) => {
    for (const assignment of assignments) {
      await tx
        .update(categories)
        .set({ necessity: assignment.necessity, updatedAt: new Date() })
        .where(eq(categories.id, assignment.categoryId));
    }
  });
  return assignments.length;
}

/**
 * Archive (soft-delete) a category. It stays valid for historical transactions
 * but drops out of pickers. Pass `archived: false` to restore.
 *
 * @param id - Category UUID.
 * @param archived - True to archive (default), false to restore.
 */
export async function archiveCategory(id: string, archived = true): Promise<void> {
  await db
    .update(categories)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(eq(categories.id, id));
}

/**
 * Merge `fromId` into `toId`: repoint every transaction and rule that references
 * the source category onto the target, then archive the source. Run in one DB
 * transaction so a partial merge can't strand references. Used to clean up
 * backfilled duplicates ("Other" leaves that should fold into a curated leaf).
 *
 * The source is archived rather than deleted: the `category_rules.category_id`
 * FK is `onDelete: restrict`, and keeping the row preserves any historical
 * references we might have missed.
 *
 * @param fromId - Source category to drain (will be archived).
 * @param toId - Target category to receive the references.
 */
export async function mergeCategory(fromId: string, toId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.id, toId))
      .limit(1);
    if (!target) throw new Error("mergeCategory: target category not found");

    await tx
      .update(transactions)
      .set({ categoryId: toId, category: target.name })
      .where(eq(transactions.categoryId, fromId));

    await tx
      .update(categoryRules)
      .set({ categoryId: toId, category: target.name })
      .where(eq(categoryRules.categoryId, fromId));

    await tx
      .update(categories)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(categories.id, fromId));
  });
}

/**
 * List all category groups (sorted).
 *
 * @returns The groups in display order.
 */
export async function listGroups(): Promise<readonly CategoryGroup[]> {
  return db
    .select()
    .from(categoryGroups)
    .orderBy(asc(categoryGroups.sortOrder), asc(categoryGroups.name));
}

/**
 * Create a category group. Relies on the unique index for dedup.
 *
 * @param input - Validated group input.
 * @returns The inserted group.
 */
export async function createGroup(input: CreateGroupInput): Promise<CategoryGroup> {
  const [row] = await db
    .insert(categoryGroups)
    .values({ name: input.name, color: input.color ? input.color : null })
    .returning();
  if (!row) throw new Error("createGroup: insert returned no row");
  return row;
}
