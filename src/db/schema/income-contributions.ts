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
import { holdingLots } from "./holding-lots.ts";
import { investmentTransactions } from "./investment-transactions.ts";
import { retirementContributions } from "./retirement-contributions.ts";

/**
 * income_contributions: the MATERIALIZED ledger — one row per contribution rule
 * per pay date (Phase 14, ADR-030/031).
 *
 * This table is what makes the whole phase idempotent and auditable. The
 * `materialize-contributions` job expands a rule's pay schedule and, for each
 * pay date NOT already present here, writes the investment transaction + the
 * cost-basis lot + this row **in one DB transaction**. Re-running the job (or
 * running it twice on a Redis hiccup) hits the UNIQUE constraint below and is a
 * no-op — CLAUDE.md §Background Jobs: idempotent by design.
 *
 * UNIQUE (retirement_contribution_id, pay_date) is therefore not a nicety; it
 * is the correctness guarantee. It is also what lets the run-once backfill walk
 * years of history and the nightly job overlap harmlessly.
 *
 * The two FKs to the ledger it created are NULLABLE with ON DELETE SET NULL:
 *   - `investment_transaction_id` — the buy (priceable) or cash deposit
 *     (basis-only) row.
 *   - `holding_lot_id` — the cost-basis lot. NULL when the rule designates no
 *     holding at all, so there is nothing to attach a lot to.
 * SET NULL (not cascade) keeps the contribution record — the fact that the user
 * contributed $X on this date — even if the derived ledger rows are later
 * cleaned up. The contribution history is the audit trail; losing it to a
 * cascade from a transaction cleanup would defeat the point.
 *
 * Every amount is `NUMERIC(18,2)` carried as a string and only ever combined
 * through `Money`/Decimal (CLAUDE.md §Money). None of these figures is ever
 * logged or transmitted (FEATURE.md 2026-08-09 privacy stance).
 */
export const incomeContributions = pgTable(
  "income_contributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The rule that produced this contribution. All three FKs on this table are
     * declared in the table extras with explicit short names — drizzle's
     * auto-generated `<table>_<col>_<reftable>_<refcol>_fk` overflows Postgres'
     * 63-char identifier limit here and would be silently TRUNCATED, leaving the
     * DB name out of sync with drizzle's snapshot.
     */
    retirementContributionId: uuid("retirement_contribution_id").notNull(),
    /** The pay date this contribution belongs to — half of the idempotency key. */
    payDate: date("pay_date", { mode: "string" }).notNull(),
    /** Gross for the period, snapshotted so history survives a later rate change. */
    grossAmount: numeric("gross_amount", { precision: 18, scale: 2 }).notNull(),
    /** The employee's own contribution — the savings-rate numerator. */
    employeeAmount: numeric("employee_amount", { precision: 18, scale: 2 }).notNull(),
    /** The employer match. Part of cost basis, excluded from the savings rate. */
    employerAmount: numeric("employer_amount", { precision: 18, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    /** The buy / cash-deposit row this contribution created. */
    investmentTransactionId: uuid("investment_transaction_id"),
    /** The cost-basis lot this contribution created; NULL when no holding is designated. */
    holdingLotId: uuid("holding_lot_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // Explicitly named FKs — see the retirementContributionId comment above.
    ruleFk: foreignKey({
      columns: [table.retirementContributionId],
      foreignColumns: [retirementContributions.id],
      name: "income_contributions_rule_fk",
    }).onDelete("cascade"),
    investmentTransactionFk: foreignKey({
      columns: [table.investmentTransactionId],
      foreignColumns: [investmentTransactions.id],
      name: "income_contributions_investment_txn_fk",
    }).onDelete("set null"),
    holdingLotFk: foreignKey({
      columns: [table.holdingLotId],
      foreignColumns: [holdingLots.id],
      name: "income_contributions_holding_lot_fk",
    }).onDelete("set null"),
    // THE idempotency key (ADR-031). Also serves every per-rule read: a btree
    // scans backward at no cost, so this covers the "recent contributions,
    // newest first" ledger view without a second, redundant DESC index.
    rulePayDateUnique: uniqueIndex("income_contributions_rule_pay_date_unique").on(
      table.retirementContributionId,
      table.payDate,
    ),
    // FK indexes for the ON DELETE SET NULL passes — an investment-transaction
    // or lot cleanup must not seq-scan this table (postgres-best-practices).
    investmentTransactionIdIdx: index("income_contributions_investment_transaction_id_idx").on(
      table.investmentTransactionId,
    ),
    holdingLotIdIdx: index("income_contributions_holding_lot_id_idx").on(table.holdingLotId),
    // Contributions are money in, never out. A negative row would silently
    // corrupt both cost basis and the savings rate.
    amountsNonNegativeCheck: check(
      "income_contributions_amounts_non_negative_check",
      sql`${table.grossAmount} >= 0
        AND ${table.employeeAmount} >= 0
        AND ${table.employerAmount} >= 0`,
    ),
  }),
);

export const incomeContributionsRelations = relations(incomeContributions, ({ one }) => ({
  rule: one(retirementContributions, {
    fields: [incomeContributions.retirementContributionId],
    references: [retirementContributions.id],
  }),
  investmentTransaction: one(investmentTransactions, {
    fields: [incomeContributions.investmentTransactionId],
    references: [investmentTransactions.id],
  }),
  holdingLot: one(holdingLots, {
    fields: [incomeContributions.holdingLotId],
    references: [holdingLots.id],
  }),
}));

export type IncomeContribution = typeof incomeContributions.$inferSelect;
export type NewIncomeContribution = typeof incomeContributions.$inferInsert;
