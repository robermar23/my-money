import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * category_groups + categories: the structured, two-level transaction taxonomy
 * (ADR-018). Supersedes the free-text `transactions.category` half of ADR-007 —
 * the regex engine stays; only the category *value* becomes a managed entity.
 *
 * Why structured (per ADR-018): free-text fragments under typos ("Coffee" vs
 * "coffee"), carries no income/expense/transfer semantics (so transfers pollute
 * spend totals), and can't be rolled up. A managed taxonomy is the prerequisite
 * for reliable per-category / per-group / per-account analytics and budgets.
 *
 * Shape:
 *   - `category_groups` are rollup buckets (Food, Housing, Income, Transfers…).
 *     Transactions never point at a group directly — only at a leaf `category`.
 *   - `categories` are the leaves transactions reference. Each leaf has a
 *     `kind ∈ {income, expense, transfer}`:
 *       * spend totals = -SUM(amount) over kind='expense'
 *       * income totals = SUM(amount) over kind='income'
 *       * kind='transfer' (WEB XFER, card payments, internal P2P) is EXCLUDED
 *         from both — this is the whole reason `kind` exists.
 *
 * `kind` is plain text + CHECK (not pgEnum) — same posture as alerts.type /
 * plaid_items.status: the closed set is small and a CHECK is lighter to evolve
 * than an enum-add migration.
 *
 * Names are unique case-insensitively (a partial-free unique index on
 * `lower(name)`) so the backfill's name-match is unambiguous and the picker
 * never shows "Coffee" twice.
 */
export const categoryGroups = pgTable(
  "category_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Lower = earlier in pickers / charts. Default 100 leaves headroom. */
    sortOrder: integer("sort_order").notNull().default(100),
    /** Optional hex color for charts/legends; null = auto-assigned at render. */
    color: text("color"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    nameLowerUnique: uniqueIndex("category_groups_name_lower_unique").on(sql`lower(${table.name})`),
  }),
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Parent group for rollups. Nullable + onDelete: set null so deleting a
     * group never destroys its leaves (they fall back to "ungrouped").
     */
    groupId: uuid("group_id").references((): AnyPgColumn => categoryGroups.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    /** 'income' | 'expense' | 'transfer' — drives analytics (see file header). */
    kind: text("kind").notNull().default("expense"),
    /** Optional hex color for charts/legends; null = auto-assigned at render. */
    color: text("color"),
    sortOrder: integer("sort_order").notNull().default(100),
    /**
     * Archived categories stay valid for historical transactions but drop out
     * of pickers. Null = active. (Soft-delete; we never hard-delete a category
     * that has history — that would orphan analytics.)
     */
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    nameLowerUnique: uniqueIndex("categories_name_lower_unique").on(sql`lower(${table.name})`),
    groupIdx: index("categories_group_id_idx").on(table.groupId),
    kindCheck: check(
      "categories_kind_check",
      sql`${table.kind} IN ('income', 'expense', 'transfer')`,
    ),
  }),
);

export const categoryGroupsRelations = relations(categoryGroups, ({ many }) => ({
  categories: many(categories),
}));

export const categoriesRelations = relations(categories, ({ one }) => ({
  group: one(categoryGroups, {
    fields: [categories.groupId],
    references: [categoryGroups.id],
  }),
}));

export type CategoryGroup = typeof categoryGroups.$inferSelect;
export type NewCategoryGroup = typeof categoryGroups.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;

/** The closed set of category kinds (ADR-018). */
export type CategoryKind = "income" | "expense" | "transfer";
