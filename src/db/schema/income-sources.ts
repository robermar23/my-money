import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { retirementContributions } from "./retirement-contributions.ts";

/**
 * income_sources: a paycheck the user has DEFINED (Phase 14, ADR-030).
 *
 * This is deliberately the smallest possible model of income: a cadence and a
 * gross-per-period, plus an anchor date to phase the schedule from. It exists
 * for exactly two purposes — (1) as the input to a 401k contribution rule
 * (`retirement_contributions`) so contributed dollars become real cost basis,
 * and (2) as the denominator of the dashboard savings rate.
 *
 * It is NOT payroll (CLAUDE.md §Domain Scope, restated in FEATURE.md 2026-08-09):
 * no net pay, no withholding, no FICA, no deduction stack, no paycheck stub. We
 * store *gross per period* and nothing about taxes. It is also not a
 * budgeting-income ledger — Phase 8 budgets stay expense-side.
 *
 * Multiple rows are the point (ADR-030): a job change mid-year is a new source
 * with the old one end-dated, and two concurrent jobs are simply two rows. A
 * singleton setting could represent neither.
 *
 * `gross_per_period` is the most sensitive column in the app. It is
 * `NUMERIC(18,2)` carried as a string end-to-end (CLAUDE.md §Money — every
 * percent-of-gross computation goes through `Money`/Decimal, never native
 * arithmetic), it never leaves local Postgres, and it is never logged.
 *
 * `cadence` is plain text + CHECK rather than a `pgEnum` — same posture as
 * `transactions.source` / `holding_lots.source` for small, evolvable
 * vocabularies.
 */
export const incomeSources = pgTable(
  "income_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** User label for the paycheck, e.g. 'Acme Corp — salary'. */
    name: text("name").notNull(),
    /** 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'. Drives pay-date expansion. */
    cadence: text("cadence").notNull(),
    /** GROSS pay per period — never net. A money string, never a float. */
    grossPerPeriod: numeric("gross_per_period", { precision: 18, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    /**
     * A known-real pay date used to PHASE the schedule (which Friday is a
     * biweekly payday). Kept separate from `start_date` so the user can
     * backfill from an earlier date without re-deriving the phase.
     */
    anchorDate: date("anchor_date", { mode: "string" }).notNull(),
    /** First date contributions may be materialized from (the backfill floor). */
    startDate: date("start_date", { mode: "string" }).notNull(),
    /** Last date contributions may be materialized through; NULL = ongoing. */
    endDate: date("end_date", { mode: "string" }),
    /** False pauses materialization without deleting the source or its history. */
    active: boolean("active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // The materialize job scans active sources; partial index keeps that scan
    // off the end-dated history rows as sources accumulate over the years.
    activeIdx: index("income_sources_active_idx")
      .on(table.startDate)
      .where(sql`${table.active} = true`),
    cadenceCheck: check(
      "income_sources_cadence_check",
      sql`${table.cadence} IN ('weekly', 'biweekly', 'semimonthly', 'monthly')`,
    ),
    // A negative paycheck is a data-entry error, not a scenario.
    grossNonNegativeCheck: check(
      "income_sources_gross_non_negative_check",
      sql`${table.grossPerPeriod} >= 0`,
    ),
    // An open-ended source has no end date; a closed one ends on/after it began.
    dateOrderCheck: check(
      "income_sources_date_order_check",
      sql`${table.endDate} IS NULL OR ${table.endDate} >= ${table.startDate}`,
    ),
  }),
);

export const incomeSourcesRelations = relations(incomeSources, ({ many }) => ({
  contributionRules: many(retirementContributions),
}));

export type IncomeSource = typeof incomeSources.$inferSelect;
export type NewIncomeSource = typeof incomeSources.$inferInsert;

/** Pay cadences an income source may declare (mirrors the CHECK above). */
export const INCOME_CADENCES = ["weekly", "biweekly", "semimonthly", "monthly"] as const;
export type IncomeCadence = (typeof INCOME_CADENCES)[number];
