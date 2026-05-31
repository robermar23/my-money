import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";
import { importBatches } from "./import-batches.ts";

/**
 * transactions: one row per posted movement on a depository / credit_card / investment account.
 *
 * Sign convention mirrors OFX <TRNAMT>: positive = credit / inflow, negative
 * = debit / outflow. For credit-card accounts the UI flips the displayed sign,
 * but the stored sign stays consistent across sources.
 *
 * Per CLAUDE.md §Schema Invariants:
 *   - UNIQUE (account_id, fitid) is the dedup key — `fitid` is OFX FITID for
 *     QFX imports and a synthetic SHA-256 of (date|amount|name|memo) for CSV.
 *   - `source` is constrained via CHECK rather than an enum because it grows
 *     across phases ('plaid' added in Phase 4).
 *
 * Indexes:
 *   - (account_id, posted_at DESC) covers the dominant read pattern
 *     (paginated per-account list).
 *   - (category) WHERE NOT NULL is a partial index for category aggregation.
 */
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references((): AnyPgColumn => accounts.id, { onDelete: "cascade" }),
    /** Posted date — OFX <DTPOSTED> truncated to a day, or the CSV row's date column. */
    postedAt: date("posted_at", { mode: "string" }).notNull(),
    /** Signed amount in the account's currency. */
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    name: text("name").notNull(),
    memo: text("memo"),
    /** Nullable; assigned by rule engine or manual override. */
    category: text("category"),
    /** Set when the user manually overrides the category; lets re-categorize skip these. */
    categoryOverriddenAt: timestamp("category_overridden_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** OFX FITID or SHA-256 of (posted_at|amount|name|memo) for CSV. Always set. */
    fitid: text("fitid").notNull(),
    /** 'qfx' | 'csv' | 'manual' | 'plaid' (Phase 4). */
    source: text("source").notNull(),
    /**
     * FK to the import that produced this row. Nullable so manual entries (and
     * Phase 4 Plaid pushes that don't go through a batch) have somewhere to sit;
     * onDelete: set null because deleting an import batch should NOT lose data
     * already in the ledger.
     */
    importBatchId: uuid("import_batch_id").references(
      (): AnyPgColumn => importBatches.id,
      { onDelete: "set null" },
    ),
    /** Original payload from the parser for debug + re-derivation. */
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    accountFitidUnique: uniqueIndex("transactions_account_fitid_unique").on(
      table.accountId,
      table.fitid,
    ),
    accountPostedAtIdx: index("transactions_account_posted_at_idx").on(
      table.accountId,
      sql`${table.postedAt} DESC`,
    ),
    categoryIdx: index("transactions_category_idx")
      .on(table.category)
      .where(sql`${table.category} IS NOT NULL`),
    sourceCheck: check(
      "transactions_source_check",
      sql`${table.source} IN ('qfx', 'csv', 'manual', 'plaid')`,
    ),
  }),
);

export const transactionsRelations = relations(transactions, ({ one }) => ({
  account: one(accounts, {
    fields: [transactions.accountId],
    references: [accounts.id],
  }),
  importBatch: one(importBatches, {
    fields: [transactions.importBatchId],
    references: [importBatches.id],
  }),
}));

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
