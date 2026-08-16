import "server-only";

import { db } from "@/db/client.ts";
import { type RecommendationDismissal, recommendationDismissals } from "@/db/schema/index.ts";
import { and, desc, eq } from "drizzle-orm";
import type { DismissalRecord } from "./engine.ts";

/**
 * Reads and writes for `recommendation_dismissals` (Phase 15, P15-34, ADR-032 §3).
 *
 * ── Why this is a second DB module in a layer that has "one entry point" ───
 * [snapshot.ts](./snapshot.ts) is the only entry point for **rule inputs**, and
 * that constraint is what makes every rule a pure function of `AdviceInput`
 * (ADR-032 §1). A dismissal is not a rule input. No rule can see one, none is
 * passed to `evaluate`, and none appears in `AdviceInput` — the engine takes them
 * as a *separate* parameter precisely so that suppression is applied to a rule's
 * output rather than folded into its reasoning. Keeping the two reads in
 * different modules is the structural expression of that split, not an exception
 * to it.
 *
 * ── Dismiss vs. snooze ─────────────────────────────────────────────────────
 * One row covers both. `snooze_until IS NULL` is "hide this indefinitely";
 * a timestamp is "hide it until then", after which the recommendation comes back
 * on its own with no further action. Re-dismissing the same subject is an UPSERT
 * on the `(rule_id, subject_key)` unique index, so a double-click writes one row
 * and a snooze can be converted to a permanent dismissal (or the reverse) without
 * an intermediate delete.
 *
 * ── Undo is a DELETE ───────────────────────────────────────────────────────
 * "I want to see this again" is the absence of a dismissal, not a third state.
 * Keeping a tombstone would mean the engine had to distinguish "dismissed",
 * "un-dismissed" and "never dismissed", and nothing in the app needs that
 * distinction — the recommendation itself is recomputed on every read anyway.
 */

/** Every dismissal, newest first. Handed straight to `runAdvice`. */
export async function listDismissals(): Promise<DismissalRecord[]> {
  const rows = await db
    .select()
    .from(recommendationDismissals)
    .orderBy(desc(recommendationDismissals.dismissedAt));
  return rows.map(toRecord);
}

/**
 * Dismiss or snooze one recommendation (P15-34).
 *
 * @param ruleId - The rule being silenced.
 * @param subjectKey - Account/category id, or `''` to silence the whole rule.
 * @param snoozeUntil - `null` dismisses indefinitely; a timestamp suppresses
 *   until then and the item returns by itself afterwards.
 * @param now - Reference instant, injected for tests.
 * @returns The stored row.
 */
export async function dismissRecommendation(
  ruleId: string,
  subjectKey: string,
  snoozeUntil: Date | null,
  now: Date = new Date(),
): Promise<RecommendationDismissal> {
  const [row] = await db
    .insert(recommendationDismissals)
    .values({ ruleId, subjectKey, snoozeUntil, dismissedAt: now })
    .onConflictDoUpdate({
      target: [recommendationDismissals.ruleId, recommendationDismissals.subjectKey],
      // Re-dismissing restamps `dismissed_at`: the user is asserting the
      // rejection again today, and the dismissed-items view sorts on it.
      set: { snoozeUntil, dismissedAt: now, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error("dismissRecommendation: upsert returned no row");
  return row;
}

/**
 * Undo a dismissal, bringing the recommendation back on the next read.
 *
 * @param ruleId - The dismissed rule.
 * @param subjectKey - The dismissed subject, or `''`.
 * @returns True when a row was actually removed.
 */
export async function undismissRecommendation(
  ruleId: string,
  subjectKey: string,
): Promise<boolean> {
  const removed = await db
    .delete(recommendationDismissals)
    .where(
      and(
        eq(recommendationDismissals.ruleId, ruleId),
        eq(recommendationDismissals.subjectKey, subjectKey),
      ),
    )
    .returning({ id: recommendationDismissals.id });
  return removed.length > 0;
}

/** Row → the narrow shape the engine consumes. */
function toRecord(row: RecommendationDismissal): DismissalRecord {
  return {
    ruleId: row.ruleId,
    subjectKey: row.subjectKey,
    dismissedAt: row.dismissedAt,
    snoozeUntil: row.snoozeUntil,
  };
}
