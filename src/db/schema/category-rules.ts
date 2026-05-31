import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * category_rules: regex-based transaction-categorization rules (ADR-007).
 *
 * Per ADR-007: privacy-preserving (matching is local), deterministic, and
 * cheap. First match (in priority order, then created_at) wins.
 *
 * - `pattern` is a JavaScript regex source string; validated at write time
 *   via `new RegExp(pattern, flags)`.
 * - `field` constrains the match target to a known column on transactions.
 * - `priority` lower = higher priority. Default 100 leaves headroom on both sides.
 */
export const categoryRules = pgTable(
  "category_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pattern: text("pattern").notNull(),
    flags: text("flags").notNull().default("i"),
    field: text("field").notNull().default("name"),
    category: text("category").notNull(),
    priority: integer("priority").notNull().default(100),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    priorityIdx: index("category_rules_priority_idx")
      .on(table.priority)
      .where(sql`${table.enabled} = true`),
    fieldCheck: check("category_rules_field_check", sql`${table.field} IN ('name', 'memo')`),
  }),
);

export type CategoryRule = typeof categoryRules.$inferSelect;
export type NewCategoryRule = typeof categoryRules.$inferInsert;
