import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";

/**
 * credit_lines: the REVOLVING terms of a credit-card account (Phase 15,
 * PLAN15 P15-03, ADR-033 §3).
 *
 * This is the revolving twin of `liabilities`, which models a fixed-rate
 * AMORTIZING loan. The debt-payoff engine (P15-11/P15-18) unions the two into
 * one `DebtTerm[]` in a helper; neither table knows about the other.
 *
 * Why a separate table rather than columns on `liabilities`: that table's
 * `principal_at_origination`, `term_months` and `start_date` are all NOT NULL
 * and meaningless for a card. Reusing it would force a `DROP NOT NULL` on a
 * working table that already drives shipped mortgage math, for no gain. This
 * table is purely additive (CLAUDE.md §Database: never drop a column, and by
 * extension don't weaken constraints on live financial data).
 *
 * Terms are MANUAL-FIRST (ADR-033 §6). Plaid's `/liabilities/get` is NOT
 * enabled: it is a per-Item subscription-fee product on any paid plan, needs
 * existing Items re-linked through update mode, and still would not cover the
 * manual accounts the engine must serve. Three rarely-changing numbers typed
 * once is less total effort. Pre-fill via Plaid is a recorded Open Item.
 *
 * Because they are hand-entered, terms go stale silently when an APR changes.
 * `updated_at` is the mitigation and is meant to be SHOWN next to the figure
 * (P15-30) so a stale APR is visible as stale rather than trusted as current.
 *
 * Balance is NOT stored here — it comes from the latest `account_snapshots` row
 * for the account, the same path every other balance in the app uses.
 *
 * UNITS (CLAUDE.md §Money): `apr` is a decimal FRACTION, e.g. "0.249900" =
 * 24.99% — matching `liabilities.annual_rate`, and deliberately a different
 * precision from the percentage-valued `accounts.apy` / `*_percent` columns so
 * the two conventions are hard to confuse. Every figure here is a numeric
 * string; the payoff simulator combines them only through Money/Decimal.
 */
export const creditLines = pgTable(
  "credit_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The `credit_card` account these terms belong to. UNIQUE — one account has
     * exactly zero or one set of revolving terms, mirroring `liabilities`.
     * Cascade: terms are meaningless without their account.
     */
    accountId: uuid("account_id")
      .notNull()
      .unique()
      .references((): AnyPgColumn => accounts.id, { onDelete: "cascade" }),
    /** Purchase APR as a decimal fraction ("0.249900" = 24.99%). See header. */
    apr: numeric("apr", { precision: 8, scale: 6 }),
    /** The card's credit limit. Drives the utilization rule (P15-19). */
    creditLimit: numeric("credit_limit", { precision: 18, scale: 2 }),
    /** Flat minimum payment per statement, when the issuer states one. */
    minimumPayment: numeric("minimum_payment", { precision: 18, scale: 2 }),
    /**
     * Minimum as a PERCENTAGE of the balance ("2.0000" = 2%), when the issuer
     * states it that way. Both may be set — issuers commonly bill the greater
     * of a flat floor and a percentage; the payoff engine takes the max.
     */
    minimumPaymentPercent: numeric("minimum_payment_percent", { precision: 7, scale: 4 }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // FK index — Postgres does not auto-index FKs, and this one serves both the
    // account → terms lookup and the ON DELETE CASCADE pass.
    accountIdIdx: index("credit_lines_account_id_idx").on(table.accountId),
    // Every term is NULL-tolerant: a user may know the limit but not the APR,
    // and the engine reports `unknown_input` for what is missing rather than
    // assuming a zero (ADR-032 consequence 1 — a confident wrong number is the
    // failure mode this whole phase is built to avoid).
    //
    // The 0–1 APR bound is the unit guard: someone typing 24.99 (percent) gets
    // rejected at the boundary instead of silently modelling a 2499% card.
    aprRangeCheck: check(
      "credit_lines_apr_range_check",
      sql`${table.apr} IS NULL OR (${table.apr} >= 0 AND ${table.apr} <= 1)`,
    ),
    creditLimitCheck: check(
      "credit_lines_credit_limit_check",
      sql`${table.creditLimit} IS NULL OR ${table.creditLimit} >= 0`,
    ),
    minimumPaymentCheck: check(
      "credit_lines_minimum_payment_check",
      sql`${table.minimumPayment} IS NULL OR ${table.minimumPayment} >= 0`,
    ),
    minimumPaymentPercentCheck: check(
      "credit_lines_minimum_payment_percent_check",
      sql`${table.minimumPaymentPercent} IS NULL
        OR (${table.minimumPaymentPercent} >= 0 AND ${table.minimumPaymentPercent} <= 100)`,
    ),
  }),
);

export const creditLinesRelations = relations(creditLines, ({ one }) => ({
  account: one(accounts, {
    fields: [creditLines.accountId],
    references: [accounts.id],
  }),
}));

export type CreditLine = typeof creditLines.$inferSelect;
export type NewCreditLine = typeof creditLines.$inferInsert;
