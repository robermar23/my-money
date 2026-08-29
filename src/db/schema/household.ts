import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * household_profile + household_members: the small amount of personal context
 * household money benchmarks need (Phase 15, PLAN15 P15-04, ADR-033 §4).
 *
 * Round 9 offered this data explicitly — "perhaps the app needs to know extra
 * info, like how many household members and age." It has nowhere else to live:
 * `users` is deliberately one row holding a password hash and nothing else.
 *
 * ── PRIVACY (CLAUDE.md §Privacy & Data Sovereignty) ────────────────────────
 * These are the most personal rows in the database — the only place the app
 * stores anything about PEOPLE rather than money. Three properties are binding,
 * not aspirational:
 *
 *   1. They never leave the box. No egress path reads them; the advice engine
 *      that consumes them makes zero outbound HTTP on any code path, and the
 *      content-free notification email (ADR-015) carries no figures at all.
 *   2. They ride the existing nightly `age`-encrypted `pg_dump` (ADR-014) like
 *      every other table. No separate handling, no separate key.
 *   3. `label` is DELIBERATELY EXCLUDED from the ⌘K search index (ADR-033 §7).
 *      There is intentionally NO trigram GIN index on it, unlike
 *      `accounts.name` / `categories.name` / `securities.name` (ADR-028). A
 *      future search phase must NOT add one reflexively: household names are
 *      not a thing you search for, and indexing them would put a person's name
 *      into a route handler's result set for no user benefit. If a search phase
 *      ever wants this, it needs its own decision first.
 *
 * A Batch-7 privacy regression test enforces (3) against the search route.
 *
 * ── Why birth YEAR ─────────────────────────────────────────────────────────
 * Every age-based rule here ("are there dependents", "how far from the
 * retirement target age", "is a catch-up contribution in play") reads an age to
 * whole-year resolution. A full birth date buys nothing and stores strictly
 * more PII, so we store the year (ADR-033, rejected alternative).
 */

/**
 * The singleton household settings row — exactly one, ever, like `users`.
 *
 * Every column is NULLABLE ON PURPOSE. Each one is an OVERRIDE of a checked-in
 * default from `src/lib/advice/constants.ts` (P15-14): NULL means "use the
 * conventional default", a value means "the user has an opinion". That keeps
 * the defaults in code where they are reviewable and testable, and keeps the
 * database from silently pinning a stale default from install day.
 */
export const householdProfile = pgTable(
  "household_profile",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Emergency-fund months, overriding the rule's 3-vs-6 selection (P15-15).
     * NULL = let the rule choose from dependents + income concentration.
     */
    reserveMonthsOverride: integer("reserve_months_override"),
    /** Target retirement age. Feeds catch-up and horizon framing only. */
    retirementTargetAge: integer("retirement_target_age"),
    /**
     * The yield the user believes they could get on cash, as a PERCENTAGE
     * ("4.5000" = 4.5%), same convention as `accounts.apy`.
     *
     * This is why ADR-033 could reject live rate fetching outright: the only
     * question a market rate would answer is "what yield am I forgoing", and a
     * user-entered benchmark answers it with ZERO egress and no staleness
     * story. The cash-drag rule (P15-20) shows a forgone-yield figure only when
     * both this and the account's own APY are present — never a guess.
     */
    benchmarkSavingsApy: numeric("benchmark_savings_apy", { precision: 7, scale: 4 }),
    /**
     * 50/30/20 split overrides as PERCENTAGES. All three or none — the CHECK
     * enforces that, plus summing to 100. The default 50/30/20 breaks in
     * high-cost-of-living areas, which is exactly why it is tunable and framed
     * as a diagnostic rather than a prescription (P15-26).
     */
    needsPct: numeric("needs_pct", { precision: 5, scale: 2 }),
    wantsPct: numeric("wants_pct", { precision: 5, scale: 2 }),
    savingsPct: numeric("savings_pct", { precision: 5, scale: 2 }),
    /**
     * Where "high-interest debt" starts, as a decimal FRACTION ("0.070000" =
     * 7%) — same convention as `credit_lines.apr` / `liabilities.annual_rate`.
     * Visible and tunable rather than a magic number buried in a rule
     * (ADR-034 §6).
     */
    highInterestThresholdApr: numeric("high_interest_threshold_apr", { precision: 8, scale: 6 }),
    /**
     * The buffer safe-to-spend subtracts before reporting a number (Phase 16,
     * ADR-037 §4 / ADR-038 §5). NULL = 0, i.e. no buffer.
     *
     * This is the user's own stated cushion, not a computed one, and it is
     * always displayed alongside the figure it reduces — a safe-to-spend number
     * without its floor is indistinguishable from a raw balance, which is
     * exactly the confusion the feature exists to remove.
     */
    cashFloor: numeric("cash_floor", { precision: 18, scale: 2 }),
    /**
     * How far the daily balance projection runs. NULL = the 60-day default from
     * `src/lib/cashflow/` — long enough to contain a full pay cycle plus a
     * monthly bill cycle plus the next one, which is the window a family can
     * still *act* in (ADR-038 §4).
     *
     * Bounded 14–365 by the CHECK below. Beyond ~90 days the residual
     * discretionary rate dominates and the line stops being information; the
     * upper bound is a guard rail, not an endorsement.
     */
    projectionHorizonDays: integer("projection_horizon_days"),
    /** Household base currency. Defaults to USD like every other money column. */
    currency: text("currency").notNull().default("USD"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    reserveMonthsCheck: check(
      "household_profile_reserve_months_check",
      sql`${table.reserveMonthsOverride} IS NULL
        OR (${table.reserveMonthsOverride} >= 1 AND ${table.reserveMonthsOverride} <= 60)`,
    ),
    retirementAgeCheck: check(
      "household_profile_retirement_age_check",
      sql`${table.retirementTargetAge} IS NULL
        OR (${table.retirementTargetAge} >= 30 AND ${table.retirementTargetAge} <= 100)`,
    ),
    benchmarkApyCheck: check(
      "household_profile_benchmark_apy_check",
      sql`${table.benchmarkSavingsApy} IS NULL
        OR (${table.benchmarkSavingsApy} >= 0 AND ${table.benchmarkSavingsApy} <= 100)`,
    ),
    // All three split percentages together or none at all, and they must sum to
    // 100. A partially-specified split has no meaning — the diagnostic compares
    // three shares against a whole.
    splitCheck: check(
      "household_profile_split_check",
      sql`(${table.needsPct} IS NULL AND ${table.wantsPct} IS NULL AND ${table.savingsPct} IS NULL)
        OR (${table.needsPct} IS NOT NULL AND ${table.wantsPct} IS NOT NULL AND ${table.savingsPct} IS NOT NULL
            AND ${table.needsPct} >= 0 AND ${table.wantsPct} >= 0 AND ${table.savingsPct} >= 0
            AND ${table.needsPct} + ${table.wantsPct} + ${table.savingsPct} = 100)`,
    ),
    highInterestThresholdCheck: check(
      "household_profile_high_interest_check",
      sql`${table.highInterestThresholdApr} IS NULL
        OR (${table.highInterestThresholdApr} >= 0 AND ${table.highInterestThresholdApr} <= 1)`,
    ),
    // A negative buffer is not "spend $200 past empty" — it is a data-entry
    // error, and it would inflate safe-to-spend in the one direction that
    // matters (ADR-038 §5).
    cashFloorCheck: check(
      "household_profile_cash_floor_check",
      sql`${table.cashFloor} IS NULL OR ${table.cashFloor} >= 0`,
    ),
    // 14–365 (ADR-037 §4). NULL-tolerant like every override on this table.
    horizonDaysCheck: check(
      "household_profile_horizon_days_check",
      sql`${table.projectionHorizonDays} IS NULL
        OR (${table.projectionHorizonDays} >= 14 AND ${table.projectionHorizonDays} <= 365)`,
    ),
  }),
);

/**
 * One row per person in the household.
 *
 * `is_dependent` is the only field that changes a number: it drives the 3-vs-6
 * month emergency-fund multiplier (P15-15). `label` and `birth_year` exist so
 * the user can tell the rows apart and so age-based rules have an input — see
 * the file header on why the year, and only the year, is stored.
 *
 * There is no FK to `household_profile`: the profile is a singleton and the
 * member list is meaningful with or without it (a household can list its people
 * before setting any override). Coupling them would only add a join.
 */
export const householdMembers = pgTable(
  "household_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * How the user refers to this person. Free text, display-only, never parsed.
     * NOT trigram-indexed and NOT searchable — see the file header.
     */
    label: text("label").notNull(),
    /** Birth YEAR only (see header). NULL = unknown; age-based rules degrade. */
    birthYear: integer("birth_year"),
    /** Drives the emergency-fund multiplier. */
    isDependent: boolean("is_dependent").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // A sane range, not a computed "not in the future" — a CHECK cannot call a
    // non-immutable function, and the upper bound is re-validated in Zod
    // against the actual current year at the boundary (P15-28).
    birthYearCheck: check(
      "household_members_birth_year_check",
      sql`${table.birthYear} IS NULL OR (${table.birthYear} >= 1900 AND ${table.birthYear} <= 2200)`,
    ),
  }),
);

// No `relations()` for either table: neither has a FK, by design (see the
// householdMembers header). Adding empty relation objects would be noise.

export type HouseholdProfile = typeof householdProfile.$inferSelect;
export type NewHouseholdProfile = typeof householdProfile.$inferInsert;
export type HouseholdMember = typeof householdMembers.$inferSelect;
export type NewHouseholdMember = typeof householdMembers.$inferInsert;
