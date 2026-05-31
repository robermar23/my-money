import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { plaidItems } from "./plaid-items.ts";

/**
 * plaid_sync_runs: one row per `/transactions/sync` invocation against a
 * Plaid Item. The sync worker (P4-18) inserts a row at the top of each run,
 * leaves `finished_at` NULL while in flight, and stamps the counts + cursor
 * at the end.
 *
 * The connections page (P4-28) reads the last N rows per Item to show
 * recent sync activity. The composite index on (plaid_item_id, started_at
 * DESC) makes that query an index-only scan.
 *
 * `onDelete: 'cascade'` on the FK is deliberate (and distinct from the
 * `accounts.plaid_item_id` SET NULL): an Item's sync history has no value
 * once the Item itself is gone, but the account transactions DO retain
 * value. Different cascades for different parent-child semantics.
 */
export const plaidSyncRuns = pgTable(
  "plaid_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    plaidItemId: uuid("plaid_item_id")
      .notNull()
      .references((): AnyPgColumn => plaidItems.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    /** NULL while the sync is in flight. */
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    /** NULL on initial sync (no prior cursor existed). */
    cursorBefore: text("cursor_before"),
    /** The cursor advanced to. NULL on failure. */
    cursorAfter: text("cursor_after"),
    addedCount: integer("added_count").notNull().default(0),
    modifiedCount: integer("modified_count").notNull().default(0),
    removedCount: integer("removed_count").notNull().default(0),
    /** How many `/transactions/sync` calls this run made (pagination rounds). */
    paginationCount: integer("pagination_count").notNull().default(1),
    /** 'webhook' | 'manual' | 'cron' | 'initial'. */
    trigger: text("trigger").notNull(),
    /** Plaid error code or local exception message on failure. */
    error: text("error"),
  },
  (table) => ({
    itemStartedAtIdx: index("plaid_sync_runs_item_started_at_idx").on(
      table.plaidItemId,
      sql`${table.startedAt} DESC`,
    ),
    triggerCheck: check(
      "plaid_sync_runs_trigger_check",
      sql`${table.trigger} IN ('webhook', 'manual', 'cron', 'initial')`,
    ),
  }),
);

export const plaidSyncRunsRelations = relations(plaidSyncRuns, ({ one }) => ({
  item: one(plaidItems, {
    fields: [plaidSyncRuns.plaidItemId],
    references: [plaidItems.id],
  }),
}));

export type PlaidSyncRun = typeof plaidSyncRuns.$inferSelect;
export type NewPlaidSyncRun = typeof plaidSyncRuns.$inferInsert;
