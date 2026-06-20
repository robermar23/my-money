import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { categories } from "./categories.ts";

/**
 * category_budgets: a single recurring monthly spending target per category
 * (ADR-018, P8-17). Budgets are deliberately *simple* — one target amount that
 * recurs every calendar month — NOT an envelope/rollover (YNAB-style) system,
 * which CLAUDE.md §Domain Scope keeps explicitly out of scope.
 *
 * Shape:
 *   - One row per category at most (`categoryId` is UNIQUE) — this is what makes
 *     `setBudget` an upsert (`ON CONFLICT (category_id) DO UPDATE`).
 *   - `amount` is the monthly target as `NUMERIC(18,2)` — a money column, carried
 *     as a string end-to-end and combined only via `Money` (CLAUDE.md §Money).
 *   - `onDelete: cascade`: deleting a category drops its budget (a budget with no
 *     category is meaningless). Categories are normally *archived*, not deleted,
 *     so this rarely fires.
 *
 * Actual-vs-target is *computed* per calendar month from transactions (see
 * `src/lib/budgets/queries.ts`); the budget row stores only the target. Group
 * budgets are a read-only rollup (sum of child category targets), not stored.
 */
export const categoryBudgets = pgTable(
  "category_budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The category this monthly target applies to. UNIQUE → at most one budget per category. */
    categoryId: uuid("category_id")
      .notNull()
      .unique()
      .references(() => categories.id, { onDelete: "cascade" }),
    /** Monthly target amount, `NUMERIC(18,2)` — a money string, never a float. */
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    categoryIdx: index("category_budgets_category_id_idx").on(table.categoryId),
  }),
);

export type CategoryBudget = typeof categoryBudgets.$inferSelect;
export type NewCategoryBudget = typeof categoryBudgets.$inferInsert;
