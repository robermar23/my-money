import { OBLIGATION_CADENCES } from "@/lib/schedule/cadence.ts";
import { relations, sql } from "drizzle-orm";
import {
  boolean,
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
import { accounts } from "./accounts.ts";
import { categories } from "./categories.ts";

/**
 * scheduled_obligations: a recurring bill or receipt the user has CONFIRMED
 * (Phase 16, PLAN16 P16-04, ADR-037 §1).
 *
 * This is the schedule half of the calendar dimension — "the mortgage is $2,150
 * on the 1st" — and it is the input to both the daily projection (ADR-038) and
 * the miss/drift alerts. The occurrence half lives in
 * [obligation-occurrences.ts](./obligation-occurrences.ts).
 *
 * ── Confirmed, never inferred ──────────────────────────────────────────────
 * Detection (Batch 3) proposes candidates; **nothing writes a row here without
 * the user clicking confirm** (ADR-036 §2). A detected-but-unconfirmed series
 * is not an obligation — it is a guess, and a guess that silently entered the
 * projection would move a number the household makes a spending decision on.
 * `source` records which path a row came in through, and `detection_key` +
 * `confidence` keep the provenance trail back to the transactions that
 * suggested it.
 *
 * ── Why `direction` instead of a signed amount ─────────────────────────────
 * `expected_amount` is a POSITIVE MAGNITUDE with a non-negativity CHECK; the
 * sign lives in `direction`. Sign conventions already differ between
 * `transactions.amount` and display, and a signed "expected amount" invites a
 * sign bug in the one place a sign bug is most expensive — the outflow side of
 * a cash-flow projection (ADR-037, rejected alternatives). An explicit
 * `direction` is unambiguous at every call site.
 *
 * ── Cadence ────────────────────────────────────────────────────────────────
 * The vocabulary is WIDER than income's (ADR-037 §3): a quarterly insurance
 * premium is a real obligation, while a quarterly *paycheck* is not something
 * this app models. Both vocabularies expand through the one shared function in
 * [schedule/occurrences.ts](../../lib/schedule/occurrences.ts) (ADR-036 §5), and
 * `OBLIGATION_CADENCES` is a declared superset of `INCOME_CADENCES`, enforced by
 * the compile-time assertion in [schedule/cadence.ts](../../lib/schedule/cadence.ts).
 * The CHECK below is DERIVED from that tuple rather than hand-typed, so editing
 * the vocabulary surfaces as a `drizzle-kit generate` diff instead of as a
 * CHECK that quietly disagrees with the code.
 *
 * Every vocabulary here is text + CHECK rather than `pgEnum` (ADR-037 §7) —
 * same posture as `transactions.source`, `holding_lots.source`,
 * `income_sources.cadence`, and `accounts.subtype`. Extending a CHECK beats an
 * enum-add migration.
 *
 * `expected_amount` is `NUMERIC(18,2)` carried as a string end-to-end and only
 * ever combined through `Money`/Decimal (CLAUDE.md §Money). `label` and
 * `detection_key` name real vendors, so like every other figure in this app they
 * never leave local Postgres and are never logged.
 */

/** Which way the money moves. The sign `expected_amount` deliberately omits. */
export const OBLIGATION_DIRECTIONS = ["outflow", "inflow"] as const;
export type ObligationDirection = (typeof OBLIGATION_DIRECTIONS)[number];

/**
 * How the projection should price a future occurrence.
 *
 * `fixed` — the stated `expected_amount`, for rent, a mortgage, a subscription.
 * `trailing_median` — re-priced from recent actuals, for a utility bill that
 * moves with the season. It narrows the error; it does not close it, which is
 * why the limitation is documented rather than hidden (ADR-038).
 */
export const OBLIGATION_AMOUNT_MODES = ["fixed", "trailing_median"] as const;
export type ObligationAmountMode = (typeof OBLIGATION_AMOUNT_MODES)[number];

/** How the row got here. `detected` still means the user confirmed it. */
export const OBLIGATION_SOURCES = ["detected", "manual"] as const;
export type ObligationSource = (typeof OBLIGATION_SOURCES)[number];

/**
 * How strongly the detector believed in the series it proposed.
 *
 * Deliberately independent of the advice layer's `Confidence` union, which
 * grades a *recommendation* rather than a *detection*. The members coincide;
 * the concepts do not, and coupling the schema to `src/lib/advice` would invert
 * the dependency direction (advice reads the database, not the reverse).
 */
export const OBLIGATION_CONFIDENCES = ["high", "medium", "low"] as const;
export type ObligationConfidence = (typeof OBLIGATION_CONFIDENCES)[number];

export const scheduledObligations = pgTable(
  "scheduled_obligations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The account the money moves through. All FKs on this table are declared in
     * the table extras with explicit short names rather than trusting drizzle's
     * generated `<table>_<col>_<reftable>_<refcol>_fk`, which runs close to (and
     * on the occurrences table, past) Postgres' 63-char identifier limit — where
     * it would be silently TRUNCATED, leaving the DB out of sync with drizzle's
     * snapshot. That was the P14-03 lesson and it is not re-learned here.
     */
    accountId: uuid("account_id").notNull(),
    /** Optional category, for reconciling an obligation against its budget. */
    categoryId: uuid("category_id"),
    /** User-facing name, e.g. 'Mortgage' or 'Auto insurance'. Never parsed. */
    label: text("label").notNull(),
    /** POSITIVE magnitude — the sign is `direction`. A money string, never a float. */
    expectedAmount: numeric("expected_amount", { precision: 18, scale: 2 }).notNull(),
    /** 'outflow' | 'inflow'. See the header on why the amount is unsigned. */
    direction: text("direction").notNull(),
    currency: text("currency").notNull().default("USD"),
    /** One of `OBLIGATION_CADENCES`. Drives occurrence expansion. */
    cadence: text("cadence").notNull(),
    /**
     * A known-real occurrence date used to PHASE the schedule (which day of the
     * month the bill lands). Kept separate from `start_date` so the user can
     * backfill from an earlier date without re-deriving the phase — the same
     * split `income_sources` uses, for the same reason.
     */
    anchorDate: date("anchor_date", { mode: "string" }).notNull(),
    /** First date occurrences may be materialized from. */
    startDate: date("start_date", { mode: "string" }).notNull(),
    /** Last date occurrences may be materialized through; NULL = open-ended. */
    endDate: date("end_date", { mode: "string" }),
    /**
     * False pauses materialization without deleting the obligation or the
     * occurrence history that explains past months. Deactivate, do not delete
     * (CLAUDE.md §Database — historical financial data is the product).
     */
    active: boolean("active").notNull().default(true),
    /** 'fixed' | 'trailing_median'. */
    amountMode: text("amount_mode").notNull().default("fixed"),
    /** 'detected' | 'manual'. */
    source: text("source").notNull(),
    /**
     * The normalized payee that produced this series (`payeeKey`, P16-08).
     * NULL for manual obligations, which is what makes the UNIQUE index below
     * partial: one payee series cannot be confirmed twice, while unlimited
     * manual obligations stay legal.
     */
    detectionKey: text("detection_key"),
    /** One of `OBLIGATION_CONFIDENCES`; NULL for manual rows (nothing guessed). */
    confidence: text("confidence"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // Explicitly named FKs — see the accountId comment above.
    accountFk: foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.id],
      name: "scheduled_obligations_account_fk",
    }).onDelete("cascade"),
    // SET NULL, not cascade: deleting a category must not delete the schedule
    // that explains the household's bills.
    categoryFk: foreignKey({
      columns: [table.categoryId],
      foreignColumns: [categories.id],
      name: "scheduled_obligations_category_fk",
    }).onDelete("set null"),
    // One confirmed series per (account, payee). Partial because manual rows
    // carry a NULL `detection_key`, and NULLs are never equal in Postgres — a
    // non-partial index would let the same detected series in twice the moment
    // two manual rows existed. (ADR-037 §1.)
    accountDetectionKeyUnique: uniqueIndex("scheduled_obligations_account_detection_key_unique")
      .on(table.accountId, table.detectionKey)
      .where(sql`${table.detectionKey} IS NOT NULL`),
    // FK index for the account cascade, and it doubles as the per-account
    // obligation listing. `category_id` deliberately gets none: this table is
    // bounded by the number of bills a household has, so the SET NULL pass on a
    // category delete is a free seq scan.
    accountIdIdx: index("scheduled_obligations_account_id_idx").on(table.accountId),
    directionCheck: check(
      "scheduled_obligations_direction_check",
      sql`${table.direction} IN (${inList(OBLIGATION_DIRECTIONS)})`,
    ),
    cadenceCheck: check(
      "scheduled_obligations_cadence_check",
      sql`${table.cadence} IN (${inList(OBLIGATION_CADENCES)})`,
    ),
    amountModeCheck: check(
      "scheduled_obligations_amount_mode_check",
      sql`${table.amountMode} IN (${inList(OBLIGATION_AMOUNT_MODES)})`,
    ),
    sourceCheck: check(
      "scheduled_obligations_source_check",
      sql`${table.source} IN (${inList(OBLIGATION_SOURCES)})`,
    ),
    // Nullable: a manual obligation guessed at nothing, so it grades nothing.
    confidenceCheck: check(
      "scheduled_obligations_confidence_check",
      sql`${table.confidence} IS NULL OR ${table.confidence} IN (${inList(OBLIGATION_CONFIDENCES)})`,
    ),
    // The magnitude invariant the `direction` column exists to protect. A
    // negative expected amount would flip an outflow into an inflow deep inside
    // the projection walk, where nothing would notice.
    amountNonNegativeCheck: check(
      "scheduled_obligations_amount_non_negative_check",
      sql`${table.expectedAmount} >= 0`,
    ),
    // An open-ended obligation has no end date; a closed one ends on/after it
    // began. Mirrors `income_sources_date_order_check` exactly, and is the same
    // invariant P16-23 re-checks at the Zod boundary.
    dateOrderCheck: check(
      "scheduled_obligations_date_order_check",
      sql`${table.endDate} IS NULL OR ${table.endDate} >= ${table.startDate}`,
    ),
  }),
);

export const scheduledObligationsRelations = relations(scheduledObligations, ({ one }) => ({
  account: one(accounts, {
    fields: [scheduledObligations.accountId],
    references: [accounts.id],
  }),
  category: one(categories, {
    fields: [scheduledObligations.categoryId],
    references: [categories.id],
  }),
}));

export type ScheduledObligation = typeof scheduledObligations.$inferSelect;
export type NewScheduledObligation = typeof scheduledObligations.$inferInsert;
