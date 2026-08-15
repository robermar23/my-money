import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";
import { holdings } from "./holdings.ts";
import { incomeContributions } from "./income-contributions.ts";
import { incomeSources } from "./income-sources.ts";

/**
 * retirement_contributions: the RULE that turns a paycheck into a 401k
 * contribution (Phase 14, ADR-030).
 *
 * One rule says: "of this income source's gross, put X in this investment
 * account (optionally buying this holding), and the employer adds Y, capped at
 * Z% of gross." The `materialize-contributions` job (ADR-031) expands the
 * source's pay schedule and turns each due period into a real
 * `investment_transactions` row + `holding_lots` lot, so contributed dollars
 * resolve through the EXISTING cost-basis precedence (ADR-012) and light up
 * gain/loss, TWR, XIRR, allocation, and snapshots with no special-casing.
 *
 * Two deliberate limits (both restated in FEATURE.md 2026-08-09):
 *   - `pretax` is a LABEL ONLY. It drives no tax math. Roth-vs-pre-tax basis
 *     treatment for withdrawals is out of scope (CLAUDE.md §Domain Scope).
 *   - The employer match is SINGLE-TIER plus a cap. A tiered "100% to 4%, then
 *     50% to 6%" formula engine is a recorded Open Item, not this phase.
 *
 * `holding_id` is OPTIONAL, and that is the whole basis-only story (ADR-031):
 * a 401k invested in an opaque institutional fund with no public price still
 * accrues cost basis from contributions even though we cannot defensibly
 * compute a share count. With a priceable holding the job buys shares at the
 * pay-date close; without one it records dollars only.
 *
 * There is intentionally NO unique constraint on `income_source_id` — the
 * materialized ledger is keyed by (rule, pay_date), so a source can carry more
 * than one rule (e.g. a pre-tax and a Roth split) without any schema change.
 * The Phase-14 UI presents one rule per source.
 *
 * All values are `numeric` strings; every computation against them goes through
 * `Money`/Decimal (CLAUDE.md §Money — percent-of-gross on a float is the #1 way
 * a contribution feature produces wrong cost basis).
 */
export const retirementContributions = pgTable(
  "retirement_contributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The paycheck this rule draws from. The FK is declared in the table extras
     * with an explicit short name — drizzle's auto-generated
     * `<table>_<col>_<reftable>_<refcol>_fk` overflows Postgres' 63-char
     * identifier limit here and would be silently TRUNCATED, leaving the DB name
     * out of sync with drizzle's snapshot (a later drop/rename would then fail).
     */
    incomeSourceId: uuid("income_source_id").notNull(),
    /** The investment (401k) account the contribution funds. */
    accountId: uuid("account_id")
      .notNull()
      .references((): AnyPgColumn => accounts.id, { onDelete: "cascade" }),
    /**
     * The position the contribution buys. NULL ⇒ basis-only (ADR-031). ON DELETE
     * SET NULL rather than cascade: deleting a position must not silently delete
     * the user's paycheck rule — the rule degrades to a valid basis-only state
     * and the UI flags it for re-targeting.
     */
    holdingId: uuid("holding_id").references((): AnyPgColumn => holdings.id, {
      onDelete: "set null",
    }),
    /** 'percent' (of gross) | 'amount' (fixed dollars per period). */
    employeeBasis: text("employee_basis").notNull(),
    /** A percentage when basis='percent', else dollars per period. */
    employeeValue: numeric("employee_value", { precision: 18, scale: 4 }).notNull(),
    /** Label only — drives NO tax math (see header). */
    pretax: boolean("pretax").notNull().default(true),
    /** 'none' | 'percent_of_gross' | 'percent_of_contribution' | 'amount'. */
    matchBasis: text("match_basis").notNull().default("none"),
    /** Percentage or dollars per period, per `match_basis`. Ignored when 'none'. */
    matchValue: numeric("match_value", { precision: 18, scale: 4 }).notNull().default("0"),
    /** Employer match ceiling as a % of gross. NULL = uncapped. */
    matchCapPercent: numeric("match_cap_percent", { precision: 7, scale: 4 }),
    /** False pauses materialization without losing the rule or its history. */
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // Explicitly named to stay inside Postgres' 63-char identifier limit (see
    // the incomeSourceId comment above). The other two auto-generated names fit,
    // but are declared here too so all three read consistently.
    incomeSourceFk: foreignKey({
      columns: [table.incomeSourceId],
      foreignColumns: [incomeSources.id],
      name: "retirement_contributions_source_fk",
    }).onDelete("cascade"),
    // FK indexes — Postgres does not auto-index FKs (postgres-best-practices:
    // schema-foreign-key-indexes). These also serve the job's rule scan and the
    // ON DELETE CASCADE / SET NULL passes from accounts and holdings.
    incomeSourceIdIdx: index("retirement_contributions_income_source_id_idx").on(
      table.incomeSourceId,
    ),
    accountIdIdx: index("retirement_contributions_account_id_idx").on(table.accountId),
    holdingIdIdx: index("retirement_contributions_holding_id_idx").on(table.holdingId),
    employeeBasisCheck: check(
      "retirement_contributions_employee_basis_check",
      sql`${table.employeeBasis} IN ('percent', 'amount')`,
    ),
    matchBasisCheck: check(
      "retirement_contributions_match_basis_check",
      sql`${table.matchBasis} IN ('none', 'percent_of_gross', 'percent_of_contribution', 'amount')`,
    ),
    // Contributions are non-negative; a percent basis is a real percentage.
    employeeValueCheck: check(
      "retirement_contributions_employee_value_check",
      sql`${table.employeeValue} >= 0
        AND (${table.employeeBasis} <> 'percent' OR ${table.employeeValue} <= 100)`,
    ),
    matchValueCheck: check(
      "retirement_contributions_match_value_check",
      sql`${table.matchValue} >= 0
        AND (${table.matchBasis} NOT IN ('percent_of_gross', 'percent_of_contribution')
             OR ${table.matchValue} <= 100)`,
    ),
    matchCapCheck: check(
      "retirement_contributions_match_cap_check",
      sql`${table.matchCapPercent} IS NULL
        OR (${table.matchCapPercent} >= 0 AND ${table.matchCapPercent} <= 100)`,
    ),
  }),
);

export const retirementContributionsRelations = relations(
  retirementContributions,
  ({ one, many }) => ({
    incomeSource: one(incomeSources, {
      fields: [retirementContributions.incomeSourceId],
      references: [incomeSources.id],
    }),
    account: one(accounts, {
      fields: [retirementContributions.accountId],
      references: [accounts.id],
    }),
    holding: one(holdings, {
      fields: [retirementContributions.holdingId],
      references: [holdings.id],
    }),
    contributions: many(incomeContributions),
  }),
);

export type RetirementContribution = typeof retirementContributions.$inferSelect;
export type NewRetirementContribution = typeof retirementContributions.$inferInsert;

/** How the employee's contribution is expressed (mirrors the CHECK above). */
export const EMPLOYEE_CONTRIBUTION_BASES = ["percent", "amount"] as const;
export type EmployeeContributionBasis = (typeof EMPLOYEE_CONTRIBUTION_BASES)[number];

/** Single-tier employer-match shapes (mirrors the CHECK above). */
export const EMPLOYER_MATCH_BASES = [
  "none",
  "percent_of_gross",
  "percent_of_contribution",
  "amount",
] as const;
export type EmployerMatchBasis = (typeof EMPLOYER_MATCH_BASES)[number];
