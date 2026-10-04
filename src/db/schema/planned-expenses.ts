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
  uuid,
} from "drizzle-orm/pg-core";
import { inList } from "./_sql.ts";
import { categories } from "./categories.ts";

/**
 * planned_expenses: a named, dated, one-off future cost (Phase 18, P18-02,
 * ADR-043).
 *
 * A roof, a wedding, a deposit, this December's Christmas. **One-off only** —
 * the recurring half of the sinking-fund problem is already solved by
 * [scheduled_obligations](./scheduled-obligations.ts), whose cadence vocabulary
 * has carried `quarterly`, `semiannual` and `annual` since ADR-037 §3. The
 * $1,340 March car-insurance bill that opens Round 12 is an `annual` obligation
 * today and is *not* a row in this table. What was genuinely unrepresentable is
 * the cost that happens **once**, and this table is sized to exactly that: no
 * cadence column, no recurrence, no occurrence child table, no materialization
 * job (ADR-043 §1-§2).
 *
 * -- The envelope boundary, and the columns that enforce it -----------------
 * [CLAUDE.md](../../../CLAUDE.md) §Domain Scope names envelope budgeting as OUT
 * of scope, and Round 12's own boundary clause agrees: *"No money is
 * partitioned, reserved, or moved between virtual buckets. The app computes a
 * number and shows it against reality."*
 *
 * So this table **deliberately has no**:
 *   - `funded_amount` — a stored "how much is in this envelope" figure, which
 *     would be a second source of truth that silently diverges from the bank;
 *   - `funded` status, or any per-cost progress state;
 *   - `funding_account_id` — an earmark the app cannot enforce and does not
 *     honour, with no consumer besides: the cash-flow projection runs against
 *     the aggregated operating-cash pool (ADR-038 §6);
 *   - a contributions child table;
 *   - `account_id` — a planned expense is a household-level future cost.
 *
 * **The absence is the design, not an omission to be filled in later.** The test
 * is whether a column would record where money "is" other than the account it
 * is actually in; if it would, it does not belong here. What the app stores is
 * the COST; the required set-aside is computed on read by
 * [lib/sinking/accrual.ts](../../lib/sinking/accrual.ts) and stored nowhere
 * (ADR-032 §3). Deleting every row leaves the household's money exactly where
 * it was, provably, because nothing was ever moved.
 *
 * `status` describes **the cost**, never the funding — `planned` (still
 * coming), `paid` (it happened), `cancelled` (it is not coming after all). Text
 * + CHECK rather than `pgEnum`, ADR-037 §7's standing posture, for the same
 * reason: extending a CHECK beats an enum-add migration.
 *
 * -- PII warning -----------------------------------------------------------
 * `label` and `notes` are free text a household writes about itself — "Emma's
 * braces", "Mom's care-home deposit" — and are among the most sensitive strings
 * this app will ever hold. They **never** appear in a log line, never appear in
 * the content-free notification email (ADR-015 — and Phase 18 ships no alert
 * type at all), are **not** added to the search index in this phase, and never
 * leave local Postgres. `pg_dump` covers this table automatically under
 * ADR-014's encrypted-backup path. The privacy regression test enforces it
 * (P18-33).
 *
 * -- Money -----------------------------------------------------------------
 * `amount` is `NUMERIC(18,2)` carried as a **string** end-to-end and only ever
 * combined through [Money](../../lib/money/money.ts)/Decimal
 * ([CLAUDE.md](../../../CLAUDE.md) §Money). Accrual is division, which is where
 * money math goes wrong: ADR-044 computes the required balance with **one**
 * division rather than multiplying a rounded monthly rate back up.
 *
 * -- `due_date` may become past --------------------------------------------
 * Entry validates future-or-today at the Zod boundary
 * ([schemas/planned-expense.ts](../../lib/schemas/planned-expense.ts)), but the
 * column is unconstrained relative to `now`, because time passes and a row that
 * was legal yesterday must not become illegal today (ADR-043 §6). A past-due
 * `planned` row is surfaced as past-due with `Mark paid` / `Cancel` actions.
 * There is no transaction matcher: pairing a one-off cost to a posted
 * transaction is a whole feature for a case one click resolves.
 *
 * **This is not an ADR-022 goal.** A planned expense is a bill you already know
 * about, and the difference from a goal is that you did not choose to have it.
 * No projection, no progress tracking, no priority ranking, no funding rules.
 */

/**
 * What became of the cost — never how much of it is funded (ADR-043 §3).
 *
 * `planned`   — still coming; the only status the requirement accrues for.
 * `paid`      — it happened. Contributes nothing, stays visible with its status.
 * `cancelled` — it is not coming after all. Same: deactivate, do not delete
 *   ([CLAUDE.md](../../../CLAUDE.md) §Database — historical financial data is
 *   the product).
 */
export const PLANNED_EXPENSE_STATUSES = ["planned", "paid", "cancelled"] as const;
export type PlannedExpenseStatus = (typeof PLANNED_EXPENSE_STATUSES)[number];

export const plannedExpenses = pgTable(
  "planned_expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** User-facing name, e.g. 'New roof'. Never parsed. PII — see the header. */
    label: text("label").notNull(),
    /**
     * POSITIVE magnitude. A planned expense is always money leaving, so unlike
     * `scheduled_obligations` there is no `direction` column to carry a sign —
     * there is nothing for it to distinguish. A money string, never a float.
     */
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    /** When the cost lands. May be in the past; see the header. */
    dueDate: date("due_date", { mode: "string" }).notNull(),
    /**
     * When accrual starts — the denominator's left edge (ADR-044 §4).
     *
     * **Stored and explicit rather than inferred, and that is load-bearing.**
     * Deriving it from `created_at` would make the required balance jump
     * backwards when an unrelated field is edited; deriving it from
     * `due_date - 12 months` would tell a household that recorded a cost
     * yesterday that it is already thousands behind — false, and the single
     * most demoralizing possible first impression. It defaults at entry to
     * today, which is honest: you start setting aside when you decide to.
     */
    accrualStartDate: date("accrual_start_date", { mode: "string" }).notNull(),
    /** Optional category, so a planned cost can be read beside its budget. */
    categoryId: uuid("category_id"),
    /** One of `PLANNED_EXPENSE_STATUSES`. Describes the cost, not the funding. */
    status: text("status").notNull().default("planned"),
    /** Set when the user marks it paid. Audit trail, not a funding figure. */
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    /** Set when the user cancels it. */
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    /** Free text. PII — see the header. */
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    // SET NULL, not cascade: deleting a category must not delete the record of
    // a cost the household still has to pay. Explicitly NAMED and short rather
    // than trusting drizzle's generated
    // `<table>_<col>_<reftable>_<refcol>_fk`, which runs close to Postgres'
    // 63-char identifier limit — where it would be silently TRUNCATED, leaving
    // the database out of sync with drizzle's snapshot. That was the P14-03
    // lesson and it is not re-learned here.
    categoryFk: foreignKey({
      columns: [table.categoryId],
      foreignColumns: [categories.id],
      name: "planned_expenses_category_fk",
    }).onDelete("set null"),
    // The one read shape this phase has: "planned costs due in the next 12
    // months". Equality before range, because `status` is the selective side
    // here — a household accumulates paid and cancelled rows for years while
    // only a handful are ever `planned`. (Note that `obligation_occurrences`
    // orders its own composite the other way around, for the opposite reason,
    // and says so there.)
    statusDueDateIdx: index("planned_expenses_status_due_date_idx").on(table.status, table.dueDate),
    // No index on `category_id`, deliberately: this table is bounded by the
    // number of costs a household plans, so the SET NULL pass on a category
    // delete is a free seq scan. Same reasoning, stated the same way, as
    // `scheduled_obligations`.
    statusCheck: check(
      "planned_expenses_status_check",
      sql`${table.status} IN (${inList(PLANNED_EXPENSE_STATUSES)})`,
    ),
    // A negative planned cost is not an inflow — there is no `direction` column
    // for it to mean anything against — it is a data-entry error, and it would
    // REDUCE the required set-aside, which is the dangerous direction.
    amountNonNegativeCheck: check(
      "planned_expenses_amount_non_negative_check",
      sql`${table.amount} >= 0`,
    ),
    // Accrual runs forward from the start date to the due date, so an inverted
    // pair would make `monthsBetween` negative and the requirement meaningless.
    // ADR-044 clamps anyway; the database refuses to store the state at all.
    dateOrderCheck: check(
      "planned_expenses_date_order_check",
      sql`${table.accrualStartDate} <= ${table.dueDate}`,
    ),
  }),
);

export const plannedExpensesRelations = relations(plannedExpenses, ({ one }) => ({
  category: one(categories, {
    fields: [plannedExpenses.categoryId],
    references: [categories.id],
  }),
}));

export type PlannedExpense = typeof plannedExpenses.$inferSelect;
export type NewPlannedExpense = typeof plannedExpenses.$inferInsert;
