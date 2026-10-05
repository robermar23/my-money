import "server-only";

import { db } from "@/db/client.ts";
import { obligationOccurrences, plannedExpenses, scheduledObligations } from "@/db/schema/index.ts";
import type { ObligationOccurrenceStatus } from "@/db/schema/obligation-occurrences.ts";
import type { PlannedExpenseStatus } from "@/db/schema/planned-expenses.ts";
import type { ObligationDirection } from "@/db/schema/scheduled-obligations.ts";
import type { ObligationCadence } from "@/lib/schedule/cadence.ts";
import { parseIsoDate } from "@/lib/schedule/occurrences.ts";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { SINKING_ELIGIBLE_CADENCES } from "./cadence.ts";
import { COLLISION_TOLERANCE, type CollidableOccurrence } from "./collisions.ts";
import { SINKING_HORIZON_MONTHS } from "./constants.ts";
import {
  type CostStreamObligation,
  type OccurrenceRow,
  type PlannedExpenseRow,
  buildCostStream,
} from "./costs.ts";
import { sinkingHorizonEnd } from "./requirement.ts";
import type { KnownFutureCost } from "./types.ts";

/**
 * The sinking fund's only database reads (P18-19, P18-22, ADR-032 §1,
 * ADR-045 §7).
 *
 * Four functions: the cost stream the requirement is computed from, the full
 * planned-expense list the manager renders, the horizon window the cash-flow
 * projection charges to days (P18-29), and the occurrence window a collision
 * check compares against. Nothing here decides anything: no money is
 * computed, no date is expanded, no cost is filtered on a rule a pure module in
 * this directory does not already own. That split is what
 * keeps the `sinking_fund` rule and every pure module in this directory testable
 * with no database at all — the property ADR-032 §1 established for advice and
 * this phase inherits unchanged.
 *
 * **Reads only.** The writes live in [mutations.ts](./mutations.ts), and the
 * split is not tidiness: `src/lib/advice/` imports this module, and
 * [privacy-egress.test.ts](../advice/privacy-egress.test.ts)'s allowlist is how
 * that import is justified. A rule that evaluates a recommendation must not be
 * one `import` away from a function that can write a row, and keeping the two
 * in separate files is what makes that reviewable rather than asserted.
 *
 * {@link loadKnownFutureCosts} is called from
 * [advice/snapshot.ts](../advice/snapshot.ts)'s existing
 * `Promise.all`. It depends on nothing else in the snapshot, so it must not
 * become another sequential pass; the loader's two-pass shape exists because the
 * essential baseline folds in debt service, and this has no such ordering.
 *
 * ── The status filter the occurrence query deliberately does NOT have ──────
 * **The planned-expense query filters `status = 'planned'`; the occurrence query
 * filters no status at all, and that asymmetry is the whole correctness of this
 * module.** `buildCostStream` admits only `scheduled` occurrences — but it also
 * dates each one's accrual window from the PREVIOUS occurrence of the same
 * obligation, *whatever its status* (ADR-045 §3), and the previous occurrence of
 * an annual premium is almost always `matched`: it was paid a year ago. Filtering
 * `status = 'scheduled'` in SQL would therefore hide exactly the row that makes
 * an annual cost fundable, `fundingStart` would fall back to the horizon start,
 * and the requirement would be **silently understated** — the same failure mode,
 * in the same direction, that P18-11 had to fix in the materializer. A test
 * covers it against the real database, because no mock can.
 *
 * PLAN18's P18-19 wording says *"eligible **scheduled** occurrences joined to
 * their obligations"*; taken literally that is the bug above, so the plan's
 * prose is what is wrong here and the Batch 5 note records it.
 *
 * ── Why there is no lower date bound ──────────────────────────────────────
 * Both queries bound only the far edge (`due_date <= horizonTo`). A near bound
 * would have to be `today` — and a still-`scheduled` occurrence with a due date
 * in the past is **overdue, not out of scope** (ADR-043 §6): it is precisely the
 * cost the page needs to show in red. There is no honest floor to put under
 * that, and the row count does not want one: only quarterly, semiannual and
 * annual obligations reach here (ADR-045 §2), so a decade of a household's
 * history is a few hundred rows with the far edge already indexed.
 *
 * ── Privacy ───────────────────────────────────────────────────────────────
 * `planned_expenses.label` and `.notes` are household free text and new PII in
 * this phase. `notes` is **not selected** — nothing downstream of the stream
 * renders it — and `label` is copied into the cost and never parsed, never
 * logged, and never leaves local Postgres. Nothing in this module reaches
 * `console` or the network (P18-33 enforces it).
 */

/**
 * Load the cost stream for the sinking horizon.
 *
 * @param today - Inclusive `YYYY-MM-DD` horizon start, from the snapshot, so
 *   the figure is deterministic and the loader's own date is the only clock.
 * @param horizonMonths - Horizon depth. Defaults to
 *   {@link SINKING_HORIZON_MONTHS}; see {@link sinkingHorizonEnd} on why a caller
 *   should leave it alone outside a test.
 * @returns Costs ascending by `(dueDate, label, sourceId)` — already filtered to
 *   the horizon, so nothing downstream re-decides what is in scope.
 */
export async function loadKnownFutureCosts(
  today: string,
  horizonMonths: number = SINKING_HORIZON_MONTHS,
): Promise<readonly KnownFutureCost[]> {
  // Dates only: this module bounds two queries and totals nothing, so it has
  // no currency to name. See `sinkingHorizonEnd`.
  const horizonTo = sinkingHorizonEnd(today, horizonMonths);

  const [expenseRows, occurrenceRows] = await Promise.all([
    db
      .select({
        id: plannedExpenses.id,
        label: plannedExpenses.label,
        amount: plannedExpenses.amount,
        currency: plannedExpenses.currency,
        dueDate: plannedExpenses.dueDate,
        accrualStartDate: plannedExpenses.accrualStartDate,
        status: plannedExpenses.status,
        categoryId: plannedExpenses.categoryId,
      })
      .from(plannedExpenses)
      // `(status, due_date)` is the index this table was given for exactly this
      // read: a household accumulates paid rows for years while only a handful
      // are ever `planned`.
      .where(
        and(
          eq(plannedExpenses.status, "planned" satisfies PlannedExpenseStatus),
          lte(plannedExpenses.dueDate, horizonTo),
        ),
      )
      .orderBy(asc(plannedExpenses.dueDate), asc(plannedExpenses.id)),
    db
      .select({
        id: obligationOccurrences.id,
        obligationId: obligationOccurrences.obligationId,
        dueDate: obligationOccurrences.dueDate,
        expectedAmount: obligationOccurrences.expectedAmount,
        status: obligationOccurrences.status,
        obligationLabel: scheduledObligations.label,
        obligationCurrency: scheduledObligations.currency,
        cadence: scheduledObligations.cadence,
        direction: scheduledObligations.direction,
        active: scheduledObligations.active,
        categoryId: scheduledObligations.categoryId,
      })
      .from(obligationOccurrences)
      .innerJoin(
        scheduledObligations,
        eq(scheduledObligations.id, obligationOccurrences.obligationId),
      )
      .where(
        and(
          // THE gate, applied in SQL as the list the compile-checked record
          // produced — never as a cadence literal typed out again here
          // (ADR-045 §2, [cadence.ts](./cadence.ts)).
          inArray(scheduledObligations.cadence, [...SINKING_ELIGIBLE_CADENCES]),
          eq(scheduledObligations.direction, "outflow" satisfies ObligationDirection),
          eq(scheduledObligations.active, true),
          lte(obligationOccurrences.dueDate, horizonTo),
        ),
      )
      .orderBy(asc(obligationOccurrences.dueDate), asc(obligationOccurrences.id)),
  ]);

  const expenses: PlannedExpenseRow[] = expenseRows.map((row) => ({
    ...row,
    status: row.status as PlannedExpenseStatus,
  }));

  // One obligation per id, rebuilt from the join's repeated columns. A second
  // query for the parents would read the same rows twice to avoid duplicating a
  // label in memory, which is the wrong trade at this size.
  const obligations = new Map<string, CostStreamObligation>();
  const occurrences: OccurrenceRow[] = [];
  for (const row of occurrenceRows) {
    if (!obligations.has(row.obligationId)) {
      obligations.set(row.obligationId, {
        id: row.obligationId,
        label: row.obligationLabel,
        currency: row.obligationCurrency,
        cadence: row.cadence as ObligationCadence,
        direction: row.direction as ObligationDirection,
        active: row.active,
        categoryId: row.categoryId,
      });
    }
    occurrences.push({
      id: row.id,
      obligationId: row.obligationId,
      dueDate: row.dueDate,
      expectedAmount: row.expectedAmount,
      status: row.status as ObligationOccurrenceStatus,
    });
  }

  return buildCostStream({
    horizonFrom: today,
    horizonTo,
    plannedExpenses: expenses,
    obligations: [...obligations.values()],
    occurrences,
  });
}

/** One `planned_expenses` row as the manager renders it, `notes` included. */
export interface PlannedExpenseRecord {
  readonly id: string;
  readonly label: string;
  readonly amount: string;
  readonly currency: string;
  readonly dueDate: string;
  readonly accrualStartDate: string;
  readonly categoryId: string | null;
  readonly status: PlannedExpenseStatus;
  readonly notes: string | null;
}

/**
 * Every planned expense the household has recorded, whatever became of it.
 *
 * **Deliberately unfiltered**, unlike {@link loadKnownFutureCosts}: this feeds
 * the manager, where a `paid` or `cancelled` row has to stay visible with its
 * status (ADR-043 §3 — deactivate, never delete). The requirement reads the
 * other query and is unaffected by anything here.
 *
 * `notes` IS selected here and nowhere else in the phase, because this is the
 * one surface that lets the household edit it back. It is PII: it is rendered
 * into a form field and never logged, never indexed, never sent anywhere
 * (CLAUDE.md §Privacy, and the table's own header).
 *
 * @returns Rows ascending by `(dueDate, id)` — the same order the cost stream
 *   uses, so the table and the itemization read alike.
 */
export async function listPlannedExpenses(): Promise<readonly PlannedExpenseRecord[]> {
  const rows = await db
    .select({
      id: plannedExpenses.id,
      label: plannedExpenses.label,
      amount: plannedExpenses.amount,
      currency: plannedExpenses.currency,
      dueDate: plannedExpenses.dueDate,
      accrualStartDate: plannedExpenses.accrualStartDate,
      categoryId: plannedExpenses.categoryId,
      status: plannedExpenses.status,
      notes: plannedExpenses.notes,
    })
    .from(plannedExpenses)
    .orderBy(asc(plannedExpenses.dueDate), asc(plannedExpenses.id));

  return rows.map((row) => ({ ...row, status: row.status as PlannedExpenseStatus }));
}

/** One recorded cost as the cash-flow projection reads it (P18-29). */
export interface PlannedExpenseWindowRow {
  readonly id: string;
  readonly label: string;
  readonly amount: string;
  readonly currency: string;
  readonly dueDate: string;
  readonly status: PlannedExpenseStatus;
}

/**
 * Recorded costs landing inside a projection horizon (P18-29).
 *
 * The third and narrowest read of this table, and the narrowness is the point:
 * the cash-flow projection needs a label, an amount and a date, so
 * `accrual_start_date`, `category_id` and above all `notes` are **not
 * selected**. `notes` is household PII with exactly one surface that renders it
 * (the manager), and a projection that selected it would put free text into the
 * module that feeds the alert evaluator (CLAUDE.md §Privacy, ADR-015).
 *
 * ── Why not reuse {@link loadKnownFutureCosts} ────────────────────────────
 * Because that stream merges planned expenses WITH eligible obligation
 * occurrences, and the projection already expands every obligation from its own
 * schedule. Feeding the merged stream to the walk would charge every quarterly
 * and annual bill in the horizon twice — the ADR-038 §2 double count, arriving
 * through the one door Phase 16 could not have closed.
 *
 * `status` is both filtered here and re-checked by
 * {@link import("@/lib/cashflow/events.ts").expandPlannedExpenseEvents}. The SQL
 * filter is for the index — `(status, due_date)`, which this table was given
 * because a household accumulates `paid` rows for years while a handful are ever
 * `planned`. The re-check is the pure function's own contract, and it is tested
 * against all three statuses there because that is where it is a rule rather
 * than a query plan.
 *
 * @param from - Inclusive horizon start, `YYYY-MM-DD`. In the projection this is
 *   today, which is what keeps past-due costs out.
 * @param to - Inclusive horizon end, `YYYY-MM-DD`.
 * @returns Rows ascending by `(dueDate, id)`. `status` is always `planned`.
 */
export async function listPlannedExpensesInWindow(
  from: string,
  to: string,
): Promise<readonly PlannedExpenseWindowRow[]> {
  const rows = await db
    .select({
      id: plannedExpenses.id,
      label: plannedExpenses.label,
      amount: plannedExpenses.amount,
      currency: plannedExpenses.currency,
      dueDate: plannedExpenses.dueDate,
      status: plannedExpenses.status,
    })
    .from(plannedExpenses)
    .where(
      and(
        eq(plannedExpenses.status, "planned" satisfies PlannedExpenseStatus),
        gte(plannedExpenses.dueDate, from),
        lte(plannedExpenses.dueDate, to),
      ),
    )
    .orderBy(asc(plannedExpenses.dueDate), asc(plannedExpenses.id));

  return rows.map((row) => ({ ...row, status: row.status as PlannedExpenseStatus }));
}

/**
 * Occurrences a candidate planned expense could be a duplicate of (ADR-045 §4).
 *
 * The rows {@link ../sinking/collisions.ts detectCollisions} needs, and it does
 * its own eligibility, direction, currency and tolerance filtering — so this
 * bounds **only the date window**, wide enough that a cost dated either side of
 * an occurrence still finds it. Re-applying the cadence gate here would put the
 * rule in two places, and `detectCollisions`'s header says which copy is
 * authoritative.
 *
 * Inactive and inflow obligations are loaded and dropped by the detector rather
 * than excluded in SQL for the same reason. The row count is small: the window
 * is weeks wide, not years.
 *
 * @param dueDate - The candidate's `YYYY-MM-DD` due date.
 * @param windowDays - Half-width of the date window. Defaults to
 *   {@link COLLISION_TOLERANCE}'s own day tolerance, so widening the tolerance
 *   cannot silently out-run the query that feeds it.
 * @returns Candidate occurrences, unordered — the detector sorts its output.
 */
export async function listCollidableOccurrences(
  dueDate: string,
  windowDays: number = COLLISION_TOLERANCE.days,
): Promise<readonly CollidableOccurrence[]> {
  const shift = (days: number): string =>
    new Date(parseIsoDate(dueDate, "due date") + days * 86_400_000).toISOString().slice(0, 10);

  const rows = await db
    .select({
      obligationId: obligationOccurrences.obligationId,
      obligationLabel: scheduledObligations.label,
      cadence: scheduledObligations.cadence,
      direction: scheduledObligations.direction,
      active: scheduledObligations.active,
      dueDate: obligationOccurrences.dueDate,
      expectedAmount: obligationOccurrences.expectedAmount,
      currency: scheduledObligations.currency,
    })
    .from(obligationOccurrences)
    .innerJoin(
      scheduledObligations,
      eq(scheduledObligations.id, obligationOccurrences.obligationId),
    )
    .where(
      and(
        gte(obligationOccurrences.dueDate, shift(-windowDays)),
        lte(obligationOccurrences.dueDate, shift(windowDays)),
      ),
    );

  return rows.map((row) => ({
    ...row,
    cadence: row.cadence as ObligationCadence,
    direction: row.direction as ObligationDirection,
  }));
}
