import { relations, sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { inList } from "./_sql.ts";
import { scheduledObligations } from "./scheduled-obligations.ts";
import { transactions } from "./transactions.ts";

/**
 * obligation_occurrences: the MATERIALIZED calendar — one row per obligation per
 * due date (Phase 16, PLAN16 P16-05, ADR-037 §2/§5/§6).
 *
 * ── UNIQUE (obligation_id, due_date) is the idempotency key ────────────────
 * This is the same contract as `income_contributions`' UNIQUE
 * `(retirement_contribution_id, pay_date)` from P14-09, chosen deliberately
 * rather than re-litigated. The `project-cashflow-daily` job walks each active
 * obligation from its last materialized occurrence to `today + horizon` and
 * upserts `ON CONFLICT (obligation_id, due_date) DO NOTHING`. Running the job
 * twice — because Redis hiccupped, because the user extended the horizon, or
 * because a previous run died halfway — is therefore a PROVABLE no-op on the
 * rows that already exist, and a partial run is safely resumable rather than
 * something a human has to reconcile (CLAUDE.md §Background Jobs).
 *
 * ── Why materialize at all, rather than expand on read ─────────────────────
 * Because a match, a skip, and a miss need somewhere durable to live (ADR-037
 * §5). If dates were expanded on read, "the mortgage did not post" would be a
 * recomputed inference that flickers as the data around it changes, and there
 * would be no row on which to record that the user deliberately skipped a
 * payment. A match is a fact with a timestamp, not a query result (§6).
 *
 * ── Why `expected_amount` is SNAPSHOTTED here ──────────────────────────────
 * Not read through the FK — copied at materialization. Two reasons, and both
 * matter:
 *
 *   1. **History must not rewrite itself.** Raising the rent in June must not
 *      retroactively claim the household paid the new figure in March. Reading
 *      the amount through `scheduled_obligations` would do exactly that, and it
 *      would silently change the residual-rate attribution (ADR-038 §2) for
 *      every window that includes the old months.
 *   2. **`amount_mode='trailing_median'` re-prices over time.** A variable
 *      obligation's expected amount is a moving estimate; the estimate that was
 *      actually used for a given due date is the auditable one.
 *
 * This is a stated consequence of ADR-037, and the confirm/edit UI (P16-25) has
 * to say so out loud — otherwise an amount edit looks like it silently failed.
 *
 * Both money columns are `NUMERIC(18,2)` carried as strings and combined only
 * through `Money`/Decimal (CLAUDE.md §Money). Nothing here is ever logged.
 */

/**
 * The occurrence lifecycle.
 *
 * `scheduled` — materialized, not yet reconciled against reality.
 * `matched` — a transaction was found for it (P16-22). Carries the txn id,
 *   the actual amount, and when the match was made.
 * `missed` — its match window closed with nothing found. This is the state the
 *   "the mortgage did not post" alert reads.
 * `skipped` — the user said this one is not happening. Distinct from `missed`
 *   on purpose: a skip is intent and must not raise an alert.
 */
export const OBLIGATION_OCCURRENCE_STATUSES = [
  "scheduled",
  "matched",
  "missed",
  "skipped",
] as const;
export type ObligationOccurrenceStatus = (typeof OBLIGATION_OCCURRENCE_STATUSES)[number];

export const obligationOccurrences = pgTable(
  "obligation_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The obligation that produced this occurrence. Both FKs on this table are
     * declared in the table extras with explicit short names: drizzle's
     * generated name for the transaction FK would be
     * `obligation_occurrences_matched_transaction_id_transactions_id_fk` — 64
     * characters, one past Postgres' 63-char limit, where it would be silently
     * TRUNCATED and leave the DB out of sync with drizzle's snapshot. That is
     * the P14-03 lesson, and this table is precisely where it would have bitten.
     */
    obligationId: uuid("obligation_id").notNull(),
    /** The due date — half of the idempotency key. */
    dueDate: date("due_date", { mode: "string" }).notNull(),
    /** Snapshotted at materialization; see the header on why not read through the FK. */
    expectedAmount: numeric("expected_amount", { precision: 18, scale: 2 }).notNull(),
    /** One of `OBLIGATION_OCCURRENCE_STATUSES`. */
    status: text("status").notNull().default("scheduled"),
    /** The transaction this occurrence matched, once matched. */
    matchedTransactionId: uuid("matched_transaction_id"),
    /**
     * What actually posted, as opposed to what was expected. The difference is
     * what the `obligation_amount_changed` alert reads (P16-28). Deliberately
     * NOT constrained non-negative: it is copied from `transactions.amount`,
     * whose sign convention is the transaction table's, not this table's.
     */
    matchedAmount: numeric("matched_amount", { precision: 18, scale: 2 }),
    /** When the match was recorded. A match is a durable fact with a time (§6). */
    matchedAt: timestamp("matched_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // Explicitly named FKs — see the obligationId comment above.
    obligationFk: foreignKey({
      columns: [table.obligationId],
      foreignColumns: [scheduledObligations.id],
      name: "obligation_occurrences_obligation_fk",
    }).onDelete("cascade"),
    // SET NULL, not cascade: an import cleanup that removes a transaction must
    // not delete the occurrence it was matched to. The occurrence is the thing
    // being tracked; losing it would erase the record that the bill came due.
    matchedTransactionFk: foreignKey({
      columns: [table.matchedTransactionId],
      foreignColumns: [transactions.id],
      name: "obligation_occurrences_matched_transaction_fk",
    }).onDelete("set null"),
    // THE idempotency key (ADR-037 §2/§5). Also covers every per-obligation
    // read — a btree scans backward at no cost, so "this obligation's recent
    // occurrences, newest first" needs no second DESC index.
    obligationDueDateUnique: uniqueIndex("obligation_occurrences_obligation_id_due_date_unique").on(
      table.obligationId,
      table.dueDate,
    ),
    // The projection's window scan (`due_date BETWEEN today AND horizon`), with
    // `status` trailing so the miss sweep gets it from the index too.
    //
    // Note the ordering is the plan's, not the textbook's: the miss sweep is
    // `status = 'scheduled' AND due_date < cutoff`, and equality-before-range
    // would put `status` first. The projection's range scan is the hotter of
    // the two, and this table is bounded by (bills × horizon) — a few hundred
    // rows a year — so the difference is immaterial today. Revisit only with a
    // measurement, per CLAUDE.md §Performance.
    dueDateStatusIdx: index("obligation_occurrences_due_date_status_idx").on(
      table.dueDate,
      table.status,
    ),
    // FK index for the ON DELETE SET NULL pass, so a transaction cleanup does
    // not seq-scan this table (the `income_contributions` precedent). Partial
    // because the overwhelming majority of rows are unmatched, which also makes
    // it the index P16-22 wants for "is this transaction already claimed?".
    matchedTransactionIdIdx: index("obligation_occurrences_matched_transaction_id_idx")
      .on(table.matchedTransactionId)
      .where(sql`${table.matchedTransactionId} IS NOT NULL`),
    statusCheck: check(
      "obligation_occurrences_status_check",
      sql`${table.status} IN (${inList(OBLIGATION_OCCURRENCE_STATUSES)})`,
    ),
    // Same magnitude invariant as the parent: the sign lives on the
    // obligation's `direction`, never on the amount.
    //
    // There is deliberately NO "status='matched' implies matched_transaction_id
    // IS NOT NULL" CHECK. The FK above is ON DELETE SET NULL, so such a
    // constraint would turn a legitimate transaction cleanup into a violation.
    // Match coherence is the matcher's job (P16-22), not the schema's.
    amountNonNegativeCheck: check(
      "obligation_occurrences_amount_non_negative_check",
      sql`${table.expectedAmount} >= 0`,
    ),
  }),
);

export const obligationOccurrencesRelations = relations(obligationOccurrences, ({ one }) => ({
  obligation: one(scheduledObligations, {
    fields: [obligationOccurrences.obligationId],
    references: [scheduledObligations.id],
  }),
  matchedTransaction: one(transactions, {
    fields: [obligationOccurrences.matchedTransactionId],
    references: [transactions.id],
  }),
}));

export type ObligationOccurrence = typeof obligationOccurrences.$inferSelect;
export type NewObligationOccurrence = typeof obligationOccurrences.$inferInsert;
