import { z } from "zod";

/** The closed set of category kinds (ADR-018). Mirrors the DB CHECK. */
export const CATEGORY_KINDS = ["income", "expense", "transfer"] as const;

/** An optional UUID form field: a real UUID, or "" (treated as "none"). */
const optionalUuid = z.string().trim().uuid("Invalid id").optional().or(z.literal(""));

/** An optional short color token (hex or tailwind-ish), or "". */
const optionalColor = z.string().trim().max(20).optional().or(z.literal(""));

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
  kind: z.enum(CATEGORY_KINDS).default("expense"),
  groupId: optionalUuid,
  color: optionalColor,
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  id: z.string().trim().uuid("Invalid id"),
  name: z.string().trim().min(1, "Name is required").max(60).optional(),
  kind: z.enum(CATEGORY_KINDS).optional(),
  groupId: optionalUuid,
  color: optionalColor,
});

export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const createGroupSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
  color: optionalColor,
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;

export const mergeCategorySchema = z
  .object({
    fromId: z.string().trim().uuid("Invalid id"),
    toId: z.string().trim().uuid("Invalid id"),
  })
  .refine((v) => v.fromId !== v.toId, { message: "Cannot merge a category into itself" });

export type MergeCategoryInput = z.infer<typeof mergeCategorySchema>;
