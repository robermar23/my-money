"use server";

import { requireUser } from "@/lib/auth/require-user.ts";
import {
  archiveCategory,
  bulkSetNecessity,
  createCategory,
  createGroup,
  mergeCategory,
  setCategoryClassification,
  updateCategory,
} from "@/lib/categories/queries.ts";
import { bulkClassifySchema, categoryClassificationSchema } from "@/lib/schemas/advice.ts";
import {
  createCategorySchema,
  createGroupSchema,
  mergeCategorySchema,
  updateCategorySchema,
} from "@/lib/schemas/category.ts";
import { revalidatePath } from "next/cache";

/**
 * Server actions for the structured category taxonomy (ADR-018, P8-06).
 *
 * Convention (per PLAN7 server-action rules): `requireUser()` → Zod validate →
 * mutate → `revalidatePath`. Single-user app, so ownership is implicit. The
 * unique `lower(name)` index is translated into a friendly duplicate message.
 */
export interface CategoryActionResult {
  error?: string;
  ok?: boolean;
  /** Id of the row just created — lets the inline-create UI select it. */
  createdId?: string;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "23505";
}

/** Revalidate the surfaces that render categories. */
function revalidateCategorySurfaces(): void {
  revalidatePath("/settings/categories");
  revalidatePath("/analysis");
}

/**
 * Revalidate the guidance surfaces too.
 *
 * A classification change moves the essential-expense baseline, which moves the
 * emergency-fund target and the needs/wants diagnostic. Separate from
 * {@link revalidateCategorySurfaces} because only classification does this —
 * renaming a category does not change a single number on `/plan`.
 */
function revalidateGuidanceSurfaces(): void {
  revalidateCategorySurfaces();
  revalidatePath("/plan");
  revalidatePath("/");
}

export async function createCategoryAction(
  _prev: CategoryActionResult,
  formData: FormData,
): Promise<CategoryActionResult> {
  await requireUser();
  const parsed = createCategorySchema.safeParse({
    name: formData.get("name"),
    kind: formData.get("kind") || "expense",
    groupId: formData.get("groupId") || "",
    color: formData.get("color") || "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    const created = await createCategory(parsed.data);
    revalidateCategorySurfaces();
    return { ok: true, createdId: created.id };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: `A category named "${parsed.data.name}" already exists` };
    }
    throw err;
  }
}

export async function updateCategoryAction(
  _prev: CategoryActionResult,
  formData: FormData,
): Promise<CategoryActionResult> {
  await requireUser();
  const parsed = updateCategorySchema.safeParse({
    id: formData.get("id"),
    name: formData.get("name") ?? undefined,
    kind: formData.get("kind") ?? undefined,
    groupId: formData.get("groupId") ?? undefined,
    color: formData.get("color") ?? undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    const updated = await updateCategory(parsed.data);
    if (!updated) return { error: "Category not found" };
    revalidateCategorySurfaces();
    return { ok: true, createdId: updated.id };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: "Another category already uses that name" };
    }
    throw err;
  }
}

export async function archiveCategoryAction(
  categoryId: string,
  archived = true,
): Promise<CategoryActionResult> {
  await requireUser();
  if (!UUID_RE.test(categoryId)) return { error: "Invalid id" };
  await archiveCategory(categoryId, archived);
  revalidateCategorySurfaces();
  return { ok: true };
}

export async function mergeCategoryAction(
  fromId: string,
  toId: string,
): Promise<CategoryActionResult> {
  await requireUser();
  const parsed = mergeCategorySchema.safeParse({ fromId, toId });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  await mergeCategory(parsed.data.fromId, parsed.data.toId);
  revalidateCategorySurfaces();
  return { ok: true };
}

/**
 * Set one category's necessity and/or baseline exclusion (PLAN15 P15-31).
 *
 * `necessity: ""` clears the classification back to unclassified — a real
 * outcome, not a validation failure. Both fields are independently optional so
 * the inline necessity control and the income-only exclusion toggle can share
 * one action without either clobbering the other's column.
 *
 * @param categoryId - The category UUID.
 * @param patch.necessity - `'essential' | 'discretionary' | 'savings' | ''`.
 * @param patch.excludedFromBaseline - Keep out of observed net income.
 * @returns CategoryActionResult with `ok` on success, or `error`.
 */
export async function setCategoryClassificationAction(
  categoryId: string,
  patch: { necessity?: string; excludedFromBaseline?: boolean },
): Promise<CategoryActionResult> {
  await requireUser();
  const parsed = categoryClassificationSchema.safeParse({ categoryId, ...patch });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const updated = await setCategoryClassification(parsed.data.categoryId, {
    ...(patch.necessity !== undefined
      ? { necessity: parsed.data.necessity ? parsed.data.necessity : null }
      : {}),
    ...(parsed.data.excludedFromBaseline !== undefined
      ? { excludedFromBaseline: parsed.data.excludedFromBaseline }
      : {}),
  });
  if (!updated) return { error: "Category not found" };

  revalidateGuidanceSurfaces();
  return { ok: true };
}

export interface BulkClassifyResult extends CategoryActionResult {
  /** How many categories were classified. */
  classified?: number;
}

/**
 * Apply a batch of necessity classifications in one pass (PLAN15 P15-31).
 *
 * The bulk pass exists because the honesty of every baseline depends on the
 * unclassified share being small, and classifying thirty categories one click at
 * a time is the kind of chore that does not get finished. Zod rejects an empty
 * confirmation and a category listed twice.
 *
 * @param assignments - `(categoryId, necessity)` pairs; `''` clears.
 * @returns The number classified, or an error.
 */
export async function bulkClassifyAction(
  assignments: readonly { categoryId: string; necessity: string }[],
): Promise<BulkClassifyResult> {
  await requireUser();
  const parsed = bulkClassifySchema.safeParse({ assignments });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const classified = await bulkSetNecessity(
    parsed.data.assignments.map((a) => ({
      categoryId: a.categoryId,
      necessity: a.necessity ? a.necessity : null,
    })),
  );

  revalidateGuidanceSurfaces();
  return { ok: true, classified };
}

export async function createGroupAction(
  _prev: CategoryActionResult,
  formData: FormData,
): Promise<CategoryActionResult> {
  await requireUser();
  const parsed = createGroupSchema.safeParse({
    name: formData.get("name"),
    color: formData.get("color") || "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    const created = await createGroup(parsed.data);
    revalidateCategorySurfaces();
    return { ok: true, createdId: created.id };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: `A group named "${parsed.data.name}" already exists` };
    }
    throw err;
  }
}
