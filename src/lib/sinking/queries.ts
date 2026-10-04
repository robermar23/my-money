import "server-only";

import { db } from "@/db/client.ts";
import { obligationOccurrences, plannedExpenses, scheduledObligations } from "@/db/schema/index.ts";
import type { ObligationOccurrenceStatus } from "@/db/schema/obligation-occurrences.ts";
import type { PlannedExpenseStatus } from "@/db/schema/planned-expenses.ts";
import type { ObligationDirection } from "@/db/schema/scheduled-obligations.ts";
import type { ObligationCadence } from "@/lib/schedule/cadence.ts";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { SINKING_ELIGIBLE_CADENCES } from "./cadence.ts";
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
 * The sinking fund's only database reads (P18-19, ADR-032 §1, ADR-045 §7).
 *
 * Two queries and a call to the pure {@link buildCostStream}. Nothing here
 * decides anything: no money is computed, no date is expanded, no cost is
 * filtered on a rule the stream builder does not already own. That split is what
 * keeps the `sinking_fund` rule and every pure module in this directory testable
 * with no database at all — the property ADR-032 §1 established for advice and
 * this phase inherits unchanged.
 *
 * Called from [advice/snapshot.ts](../advice/snapshot.ts)'s existing
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
