"use server";

import { dismissRecommendation, undismissRecommendation } from "@/lib/advice/dismissals.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { dismissRecommendationSchema } from "@/lib/schemas/advice.ts";
import { revalidatePath } from "next/cache";

/**
 * Dismiss / snooze / undo for guidance recommendations (Phase 15, P15-34).
 *
 * These write the **only** persisted advice state in the app (ADR-032 §3).
 * Everything else on `/plan` is recomputed on every read, which is why there is
 * no "refresh" action here and no cache to invalidate beyond the two pages that
 * render recommendations.
 *
 * Nothing in this file logs a figure. A dismissal names a rule and a subject id,
 * never an amount (CLAUDE.md §Privacy).
 */

export interface DismissActionResult {
  readonly ok?: true;
  readonly error?: string;
}

/** Both surfaces that render recommendations, so an undo shows up immediately. */
function revalidateGuidanceSurfaces(): void {
  revalidatePath("/plan");
  revalidatePath("/");
}

/**
 * Hide a recommendation, permanently or until a date.
 *
 * @param formData - `ruleId`, optional `subjectKey` (`''` = the whole rule), and
 *   optional `snoozeDays` (blank = dismiss indefinitely).
 * @returns `{ ok: true }`, or a message when validation fails.
 */
export async function dismissRecommendationAction(
  _prev: DismissActionResult,
  formData: FormData,
): Promise<DismissActionResult> {
  await requireUser();

  const parsed = dismissRecommendationSchema.safeParse({
    ruleId: formData.get("ruleId"),
    subjectKey: formData.get("subjectKey") ?? "",
    snoozeDays: formData.get("snoozeDays") ?? "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const now = new Date();
  const days = parsed.data.snoozeDays?.trim();
  // A snooze is stored as an absolute instant, not a duration: the engine asks
  // "is this timestamp in the past yet", and a duration would need a reference
  // date that the row does not carry.
  const snoozeUntil =
    days === undefined || days.length === 0
      ? null
      : new Date(now.getTime() + Number(days) * 86_400_000);

  await dismissRecommendation(parsed.data.ruleId, parsed.data.subjectKey ?? "", snoozeUntil, now);
  revalidateGuidanceSurfaces();
  return { ok: true };
}

/**
 * Bring a dismissed recommendation back (the undo affordance).
 *
 * @param ruleId - The dismissed rule.
 * @param subjectKey - The dismissed subject, or `''`.
 * @returns `{ ok: true }` whether or not a row existed — undoing an already-undone
 *   dismissal is not an error, it is the state the user asked for.
 */
export async function restoreRecommendationAction(
  ruleId: string,
  subjectKey: string,
): Promise<DismissActionResult> {
  await requireUser();
  if (ruleId.trim().length === 0) return { error: "Missing rule" };

  await undismissRecommendation(ruleId, subjectKey);
  revalidateGuidanceSurfaces();
  return { ok: true };
}
