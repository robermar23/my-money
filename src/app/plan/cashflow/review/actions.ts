"use server";

import { dismissRecommendation, undismissRecommendation } from "@/lib/advice/dismissals.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import {
  CANDIDATE_DISMISSAL_RULE_ID,
  candidateSubjectKey,
  findCandidate,
  findLiabilityCandidate,
  liabilitySubjectKey,
} from "@/lib/cashflow/candidate-loader.ts";
import {
  DEFAULT_PROJECTION_HORIZON_DAYS,
  MATERIALIZATION_LEAD_DAYS,
} from "@/lib/cashflow/constants.ts";
import { materializeOccurrences } from "@/lib/cashflow/materialize.ts";
import {
  deactivateObligation,
  listObligations,
  reactivateObligation,
  upsertObligation,
} from "@/lib/cashflow/queries.ts";
import { loadHousehold } from "@/lib/household/queries.ts";
import {
  confirmCandidateSchema,
  confirmLiabilityCandidateSchema,
  deactivateObligationSchema,
  dismissCandidateSchema,
  dismissLiabilityCandidateSchema,
  obligationSchema,
} from "@/lib/schemas/cashflow.ts";
import { materializationDaysAhead } from "@/lib/sinking/coverage.ts";
import { revalidatePath } from "next/cache";

/**
 * Server actions for the candidate review and obligation surface (P16-24,
 * P16-25, ADR-036 §2/§3).
 *
 * ── Detection proposes; the user disposes ──────────────────────────────────
 * Nothing in this file writes an obligation without an explicit click, and
 * `confirmCandidateAction` re-derives the candidate list server-side before it
 * writes. That is not belt-and-braces: it is what makes `source='detected'`
 * *mean* something. Without it a hand-crafted POST could create a row claiming
 * high-confidence detector provenance for a series the detector never proposed,
 * and the review page would then show a fabricated confidence beside it. The
 * form supplies the user's EDITS; the server supplies the PROVENANCE.
 *
 * ── Deactivate, never delete ───────────────────────────────────────────────
 * There is no delete action here, and that is deliberate (CLAUDE.md §Database).
 * The occurrence history is what explains the household's past months and what
 * the residual attribution reads (ADR-038 §2); deleting an obligation cascades
 * it away and silently changes every window that included those months.
 *
 * ── Privacy ────────────────────────────────────────────────────────────────
 * Obligation labels name real vendors and every amount is real money. Nothing
 * here reaches `console`, and every error returned to the user is a sentence
 * rather than a row dump (CLAUDE.md §Privacy).
 */

const REVIEW_PATH = "/plan/cashflow/review";

export interface CashFlowActionResult {
  readonly ok?: true;
  readonly error?: string;
  /** Set on create so the client can focus the new row. */
  readonly createdId?: string;
}

/** Read a FormData field as a string, mapping absent/File values to undefined. */
function field(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

/** Both surfaces that render obligations, so a change shows up immediately. */
function revalidateCashFlowSurfaces(): void {
  revalidatePath(REVIEW_PATH);
  revalidatePath("/plan/cashflow");
}

/** Today in UTC, `YYYY-MM-DD` — the reference date every pure module is given. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Materialize an obligation's calendar out to the household's horizon.
 *
 * Called after a create or an edit so the projection has rows to read without
 * waiting for the nightly job. Idempotent by construction (ADR-037 §2), so
 * doing it here and again tonight costs one no-op insert.
 *
 * The lead is per cadence (P18-11), exactly as the nightly job computes it. This
 * call site matters as much as that one: without it, a household that has just
 * confirmed an annual premium would see no occurrence row beyond ~90 days, and
 * the sinking-fund requirement would omit the very cost they created the
 * obligation in order to see — until the next nightly run.
 */
async function materializeThroughHorizon(obligationId: string): Promise<void> {
  const [obligation] = (await listObligations({ includeInactive: true })).filter(
    (row) => row.id === obligationId,
  );
  if (!obligation) return;

  const { profile } = await loadHousehold();
  const horizon = profile?.projectionHorizonDays ?? DEFAULT_PROJECTION_HORIZON_DAYS;
  const daysAhead = materializationDaysAhead(
    obligation.cadence,
    horizon + MATERIALIZATION_LEAD_DAYS,
  );
  const through = new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

  await materializeOccurrences(
    {
      id: obligation.id,
      cadence: obligation.cadence,
      anchorDate: obligation.anchorDate,
      startDate: obligation.startDate,
      endDate: obligation.endDate,
      expectedAmount: obligation.expectedAmount,
      active: obligation.active,
    },
    through,
  );
}

/* -------------------------------------------------------------- candidates */

/**
 * Confirm a detected candidate as a real obligation.
 *
 * @param _prev - Previous action state (unused; required by useActionState).
 * @param formData - The candidate's identity plus any edits the user made.
 * @returns `ok` with the new id, or a user-facing `error`.
 */
export async function confirmCandidateAction(
  _prev: CashFlowActionResult,
  formData: FormData,
): Promise<CashFlowActionResult> {
  await requireUser();

  const parsed = confirmCandidateSchema.safeParse({
    accountId: field(formData, "accountId"),
    detectionKey: field(formData, "detectionKey"),
    categoryId: field(formData, "categoryId") ?? "",
    label: field(formData, "label"),
    expectedAmount: field(formData, "expectedAmount"),
    direction: field(formData, "direction"),
    cadence: field(formData, "cadence"),
    anchorDate: field(formData, "anchorDate"),
    startDate: field(formData, "startDate"),
    amountMode: field(formData, "amountMode"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // "Already confirmed" is checked BEFORE re-derivation, because a confirmed
  // series is filtered out of the candidate list — so without this a
  // double-click would be reported as "no longer available", which is true but
  // unhelpful. Both sentences below are now accurate for the case they cover.
  const alreadyConfirmed = (await listObligations({ includeInactive: true })).some(
    (row) =>
      row.accountId === parsed.data.accountId && row.detectionKey === parsed.data.detectionKey,
  );
  if (alreadyConfirmed) return { error: "That series is already confirmed." };

  const today = todayIso();
  const candidate = await findCandidate(parsed.data.accountId, parsed.data.detectionKey, {
    today,
  });
  if (!candidate) {
    // The form is not describing anything the detector proposed — a stale page,
    // or a request that was not built by this page at all.
    return {
      error: "That suggestion is no longer available — reload the page to see the current list.",
    };
  }

  let id: string;
  try {
    id = await upsertObligation({
      accountId: parsed.data.accountId,
      categoryId: parsed.data.categoryId ?? candidate.categoryId,
      label: parsed.data.label,
      expectedAmount: parsed.data.expectedAmount,
      direction: parsed.data.direction,
      currency: "USD",
      cadence: parsed.data.cadence,
      anchorDate: parsed.data.anchorDate,
      startDate: parsed.data.startDate,
      endDate: null,
      active: true,
      amountMode: parsed.data.amountMode,
      source: "detected",
      detectionKey: parsed.data.detectionKey,
      // A detected series is proposed by bank text, not by stated loan terms.
      liabilityId: null,
      // From the SERVER's candidate, never from the form — see the file header.
      confidence: candidate.confidence,
      notes: null,
    });
  } catch {
    // The partial UNIQUE index on (account_id, detection_key) doing its job.
    // Reachable only by two confirmations racing past the check above — the
    // index, not application bookkeeping, is what makes the outcome one row.
    return { error: "That series is already confirmed." };
  }

  await materializeThroughHorizon(id);
  revalidateCashFlowSurfaces();
  return { ok: true, createdId: id };
}

/**
 * Hide a candidate, permanently or until a date.
 *
 * Stored in `recommendation_dismissals` under a synthetic rule id — see
 * [candidate-loader.ts](../../../../lib/cashflow/candidate-loader.ts) on why
 * this needs no table of its own.
 *
 * @param _prev - Previous action state (unused; required by useActionState).
 * @param formData - `accountId`, `detectionKey`, optional `snoozeDays`.
 * @returns `ok`, or a message when validation fails.
 */
export async function dismissCandidateAction(
  _prev: CashFlowActionResult,
  formData: FormData,
): Promise<CashFlowActionResult> {
  await requireUser();

  const parsed = dismissCandidateSchema.safeParse({
    accountId: field(formData, "accountId"),
    detectionKey: field(formData, "detectionKey"),
    snoozeDays: field(formData, "snoozeDays") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const now = new Date();
  const days = parsed.data.snoozeDays?.trim();
  // A snooze is stored as an absolute instant, not a duration: the filter asks
  // "is this timestamp in the past yet", and a duration would need a reference
  // date the row does not carry.
  const snoozeUntil =
    days === undefined || days.length === 0
      ? null
      : new Date(now.getTime() + Number(days) * 86_400_000);

  await dismissRecommendation(
    CANDIDATE_DISMISSAL_RULE_ID,
    candidateSubjectKey(parsed.data.accountId, parsed.data.detectionKey),
    snoozeUntil,
    now,
  );
  revalidateCashFlowSurfaces();
  return { ok: true };
}

/**
 * Bring a dismissed candidate back.
 *
 * @param accountId - The candidate's account.
 * @param detectionKey - The candidate's payee key.
 * @returns `ok` whether or not a row existed — undoing an already-undone
 *   dismissal is not an error, it is the state the user asked for.
 */
export async function restoreCandidateAction(
  accountId: string,
  detectionKey: string,
): Promise<CashFlowActionResult> {
  await requireUser();
  if (accountId.trim().length === 0 || detectionKey.trim().length === 0) {
    return { error: "Missing the suggestion to restore" };
  }

  await undismissRecommendation(
    CANDIDATE_DISMISSAL_RULE_ID,
    candidateSubjectKey(accountId, detectionKey),
  );
  revalidateCashFlowSurfaces();
  return { ok: true };
}

/* --------------------------------------------------- liability candidates */

/**
 * Confirm a schedule proposed from stated loan terms (CF-A5, ADR-047).
 *
 * The same preview → confirm boundary the detected path uses, and the same
 * division of labour: **the form supplies the user's EDITS, the server supplies
 * the PROVENANCE.** Only four fields cross from the browser — name, amount,
 * category, and which account the money leaves — and every one of them is
 * something a person could reasonably disagree with. The cadence, the anchor,
 * the start date and `amount_mode` are re-derived here from the household's own
 * loan terms and payments, so a hand-crafted POST cannot assert a schedule the
 * app never proposed.
 *
 * Two guards worth naming:
 *
 *   1. **The account must be one the candidate itself offered.** A uuid that
 *      parses is not a checking account the household could pay from, and
 *      attaching the largest bill in the month to the wrong balance moves the
 *      low-water date — which is the one number this whole surface exists to
 *      state.
 *   2. **`detection_key` is written NULL, on purpose** (ADR-047 §4). The matcher
 *      matches on that column; a synthetic key would match no transaction that
 *      will ever exist, so the occurrence would stay unmatched and the residual
 *      would keep the payment inside the flat daily rate while the calendar
 *      also dated it. Confirming here must RE-DATE spend the projection already
 *      contained, never add any.
 *
 * @param _prev - Previous action state (unused; required by useActionState).
 * @param formData - The loan's identity plus the four editable fields.
 * @returns `ok` with the new id, or a user-facing `error`.
 */
export async function confirmLiabilityCandidateAction(
  _prev: CashFlowActionResult,
  formData: FormData,
): Promise<CashFlowActionResult> {
  await requireUser();

  const parsed = confirmLiabilityCandidateSchema.safeParse({
    liabilityId: field(formData, "liabilityId"),
    accountId: field(formData, "accountId"),
    categoryId: field(formData, "categoryId") ?? "",
    label: field(formData, "label"),
    expectedAmount: field(formData, "expectedAmount"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // Checked before re-derivation, for the reason the detected path documents: a
  // confirmed loan is filtered out of the candidate list, so without this a
  // double-click would report "no longer available" — true, but unhelpful.
  const alreadyConfirmed = (await listObligations({ includeInactive: true })).some(
    (row) => row.liabilityId === parsed.data.liabilityId,
  );
  if (alreadyConfirmed) return { error: "That loan's payment is already on your calendar." };

  const candidate = await findLiabilityCandidate(parsed.data.liabilityId, { today: todayIso() });
  if (!candidate) {
    return {
      error: "That suggestion is no longer available — reload the page to see the current list.",
    };
  }

  const payable = candidate.accountOptions.some(
    (account) => account.accountId === parsed.data.accountId,
  );
  if (!payable) {
    return { error: "Pick one of your everyday accounts for this payment to come out of." };
  }

  let id: string;
  try {
    id = await upsertObligation({
      accountId: parsed.data.accountId,
      categoryId: parsed.data.categoryId,
      label: parsed.data.label,
      expectedAmount: parsed.data.expectedAmount,
      // A loan payment leaves; there is no other direction it could go.
      direction: "outflow",
      currency: "USD",
      // Monthly by construction — the schedule amortizes in `term_months`.
      cadence: "monthly",
      // From the SERVER's candidate, never from the form — see the header.
      anchorDate: candidate.anchorDate,
      startDate: candidate.startDate,
      // Left open rather than computed from the term: a household that
      // refinances or overpays would otherwise find its calendar quietly ending
      // on a date nobody chose (ADR-047 §7).
      endDate: null,
      active: true,
      amountMode: candidate.amountMode,
      source: "liability",
      // ADR-047 §4 — the mechanism, not an omission. See the header.
      detectionKey: null,
      liabilityId: parsed.data.liabilityId,
      // Nothing was guessed, so nothing is graded.
      confidence: null,
      notes: null,
    });
  } catch {
    // The partial UNIQUE index on (liability_id) doing its job. Reachable only
    // by two confirmations racing past the check above — the index, not
    // application bookkeeping, is what makes the outcome one row.
    return { error: "That loan's payment is already on your calendar." };
  }

  await materializeThroughHorizon(id);
  revalidateCashFlowSurfaces();
  return { ok: true, createdId: id };
}

/**
 * Hide a liability candidate, permanently or until a date.
 *
 * A household that pays its mortgage from an account this app does not track
 * gets a proposal it should refuse, and refusing has to be one click. Stored in
 * `recommendation_dismissals` under the shared candidate rule id with the
 * subject key `"liability <id>"` — no new table (ADR-047 §5).
 *
 * @param _prev - Previous action state (unused; required by useActionState).
 * @param formData - `liabilityId`, optional `snoozeDays`.
 * @returns `ok`, or a message when validation fails.
 */
export async function dismissLiabilityCandidateAction(
  _prev: CashFlowActionResult,
  formData: FormData,
): Promise<CashFlowActionResult> {
  await requireUser();

  const parsed = dismissLiabilityCandidateSchema.safeParse({
    liabilityId: field(formData, "liabilityId"),
    snoozeDays: field(formData, "snoozeDays") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const now = new Date();
  const days = parsed.data.snoozeDays?.trim();
  const snoozeUntil =
    days === undefined || days.length === 0
      ? null
      : new Date(now.getTime() + Number(days) * 86_400_000);

  await dismissRecommendation(
    CANDIDATE_DISMISSAL_RULE_ID,
    liabilitySubjectKey(parsed.data.liabilityId),
    snoozeUntil,
    now,
  );
  revalidateCashFlowSurfaces();
  return { ok: true };
}

/**
 * Bring a dismissed liability candidate back.
 *
 * @param liabilityId - The loan whose proposal should return.
 * @returns `ok` whether or not a row existed — undoing an already-undone
 *   dismissal is not an error, it is the state the user asked for.
 */
export async function restoreLiabilityCandidateAction(
  liabilityId: string,
): Promise<CashFlowActionResult> {
  await requireUser();
  if (liabilityId.trim().length === 0) return { error: "Missing the suggestion to restore" };

  await undismissRecommendation(CANDIDATE_DISMISSAL_RULE_ID, liabilitySubjectKey(liabilityId));
  revalidateCashFlowSurfaces();
  return { ok: true };
}

/* ------------------------------------------------------------- obligations */

/**
 * Create or edit an obligation by hand (P16-25).
 *
 * An edit changes FUTURE materialization only. Already-materialized occurrences
 * snapshot their own `expected_amount` (ADR-037 §5), so history stays exactly as
 * it happened — the form says so out loud, because otherwise an amount edit
 * looks like it silently failed.
 *
 * @param _prev - Previous action state (unused; required by useActionState).
 * @param formData - The obligation form fields; `id` present means edit.
 * @returns `ok` with the id, or a user-facing `error`.
 */
export async function saveObligationAction(
  _prev: CashFlowActionResult,
  formData: FormData,
): Promise<CashFlowActionResult> {
  await requireUser();

  const id = field(formData, "id");
  const parsed = obligationSchema.safeParse({
    accountId: field(formData, "accountId"),
    categoryId: field(formData, "categoryId") ?? "",
    label: field(formData, "label"),
    expectedAmount: field(formData, "expectedAmount"),
    direction: field(formData, "direction"),
    currency: field(formData, "currency") || "USD",
    cadence: field(formData, "cadence"),
    anchorDate: field(formData, "anchorDate"),
    startDate: field(formData, "startDate"),
    endDate: field(formData, "endDate") ?? "",
    amountMode: field(formData, "amountMode"),
    notes: field(formData, "notes") ?? "",
    active: field(formData, "active"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // An existing row keeps its provenance: editing a detected obligation must not
  // silently relabel it as manual, or the detector would re-propose the series
  // the moment its `detection_key` was cleared.
  const existing =
    id === undefined
      ? undefined
      : (await listObligations({ includeInactive: true })).find((row) => row.id === id);
  if (id !== undefined && !existing) return { error: "Unknown obligation" };

  const savedId = await upsertObligation({
    id: existing?.id,
    accountId: parsed.data.accountId,
    categoryId: parsed.data.categoryId,
    label: parsed.data.label,
    expectedAmount: parsed.data.expectedAmount,
    direction: parsed.data.direction,
    currency: parsed.data.currency,
    cadence: parsed.data.cadence,
    anchorDate: parsed.data.anchorDate,
    startDate: parsed.data.startDate,
    endDate: parsed.data.endDate,
    active: parsed.data.active,
    amountMode: parsed.data.amountMode,
    source: existing?.source ?? "manual",
    detectionKey: existing?.detectionKey ?? null,
    // Provenance is re-read from the stored row, never taken from the form —
    // the same rule `detectionKey` and `confidence` follow. A hand-crafted POST
    // must not be able to claim a schedule came from a loan the user stated.
    liabilityId: existing?.liabilityId ?? null,
    confidence: existing?.confidence ?? null,
    notes: parsed.data.notes,
  });

  await materializeThroughHorizon(savedId);
  revalidateCashFlowSurfaces();
  return { ok: true, createdId: savedId };
}

/**
 * Pause an obligation without deleting it.
 *
 * @param id - The obligation to deactivate.
 * @returns `ok`, or a message when the id is malformed.
 */
export async function deactivateObligationAction(id: string): Promise<CashFlowActionResult> {
  await requireUser();
  const parsed = deactivateObligationSchema.safeParse({ id });
  if (!parsed.success) return { error: "Unknown obligation" };

  await deactivateObligation(parsed.data.id);
  revalidateCashFlowSurfaces();
  return { ok: true };
}

/**
 * Resume a paused obligation, preserving the occurrence history that explains
 * its past. The correct route when a stopped series restarts — creating a fresh
 * obligation would leave that history orphaned.
 *
 * @param id - The obligation to reactivate.
 * @returns `ok`, or a message when the id is malformed.
 */
export async function reactivateObligationAction(id: string): Promise<CashFlowActionResult> {
  await requireUser();
  const parsed = deactivateObligationSchema.safeParse({ id });
  if (!parsed.success) return { error: "Unknown obligation" };

  if (await reactivateObligation(parsed.data.id)) {
    await materializeThroughHorizon(parsed.data.id);
  }
  revalidateCashFlowSurfaces();
  return { ok: true };
}
