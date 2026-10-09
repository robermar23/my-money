"use server";

import { db } from "@/db/client.ts";
import { accounts, holdings, incomeSources, retirementContributions } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import {
  type ComputedContribution,
  type ContributionRuleInput as ContributionRuleMath,
  computeContribution,
} from "@/lib/income/contribution.ts";
import { countMaterializedContributions, listIncomeDeposits } from "@/lib/income/queries.ts";
import { savingsRate } from "@/lib/income/savings-rate.ts";
import { periodsPerYear } from "@/lib/income/schedule.ts";
import {
  LOOKBACK_DAYS,
  TOLERANCE_DAYS,
  suggestTakeHome,
} from "@/lib/income/take-home-suggestion.ts";
import { Money } from "@/lib/money/money.ts";
import { QUEUE_NAMES, materializeContributionsQueue } from "@/lib/queue/queues.ts";
import {
  contributionPreviewSchema,
  contributionRuleSchema,
  incomeSourceSchema,
  takeHomeSuggestionSchema,
} from "@/lib/schemas/income.ts";
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

/**
 * Server actions for `/settings/income` (P14-14, P14-15).
 *
 * Three rules govern everything below:
 *
 * 1. **Nothing here materializes a contribution.** These actions only define
 *    intent; the `materialize-contributions` job (ADR-031) is the sole writer of
 *    `investment_transactions` / `holding_lots` / `income_contributions`. Keeping
 *    one writer is what makes the idempotency guarantee hold.
 * 2. **No income figure is ever logged.** Gross pay and contribution amounts are
 *    the most sensitive data in the app (CLAUDE.md §Privacy). Errors returned to
 *    the user are sentences, not dumps; nothing reaches `console`.
 * 3. **Destructive actions refuse when history exists.** Deleting a source or a
 *    rule cascades its `income_contributions` — the audit trail behind real cost
 *    basis — while leaving the derived lots in place. We deactivate instead.
 */

const SETTINGS_PATH = "/settings/income";

export interface IncomeActionResult {
  error?: string;
  ok?: boolean;
  /** Set on create so the client can focus the new row. */
  createdId?: string;
}

/** Read a FormData field as a string, mapping absent/File values to undefined. */
function field(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

/** A UUID that arrived from a client control; rejected rather than queried blind. */
function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

/* ------------------------------------------------------------------ sources */

/**
 * Create an income source (the paycheck).
 *
 * @param _prev - Previous action state (unused; required by useActionState).
 * @param formData - The source form fields.
 * @returns `ok` plus the new id, or a user-facing `error`.
 */
export async function createIncomeSourceAction(
  _prev: IncomeActionResult,
  formData: FormData,
): Promise<IncomeActionResult> {
  await requireUser();
  const parsed = incomeSourceSchema.safeParse({
    name: field(formData, "name"),
    cadence: field(formData, "cadence"),
    grossPerPeriod: field(formData, "grossPerPeriod"),
    netPerPeriod: field(formData, "netPerPeriod") ?? "",
    currency: field(formData, "currency") || "USD",
    anchorDate: field(formData, "anchorDate"),
    startDate: field(formData, "startDate"),
    endDate: field(formData, "endDate") ?? "",
    notes: field(formData, "notes") ?? "",
    active: field(formData, "active"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const [created] = await db
    .insert(incomeSources)
    .values(parsed.data)
    .returning({ id: incomeSources.id });
  revalidatePath(SETTINGS_PATH);
  return { ok: true, createdId: created?.id };
}

/**
 * Edit an income source. Editing `gross_per_period` or the schedule changes
 * FUTURE materialization only — already-materialized contributions snapshot
 * their own gross, so history stays exactly as it happened.
 */
export async function updateIncomeSourceAction(
  _prev: IncomeActionResult,
  formData: FormData,
): Promise<IncomeActionResult> {
  await requireUser();
  const id = field(formData, "id");
  if (!isUuid(id)) return { error: "Unknown income source" };

  const parsed = incomeSourceSchema.safeParse({
    name: field(formData, "name"),
    cadence: field(formData, "cadence"),
    grossPerPeriod: field(formData, "grossPerPeriod"),
    netPerPeriod: field(formData, "netPerPeriod") ?? "",
    currency: field(formData, "currency") || "USD",
    anchorDate: field(formData, "anchorDate"),
    startDate: field(formData, "startDate"),
    endDate: field(formData, "endDate") ?? "",
    notes: field(formData, "notes") ?? "",
    active: field(formData, "active"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const updated = await db
    .update(incomeSources)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(incomeSources.id, id))
    .returning({ id: incomeSources.id });
  if (updated.length === 0) return { error: "Unknown income source" };

  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

/**
 * Pause or resume a source. Pausing stops future materialization without
 * touching a single historical contribution — the reason delete is rarely the
 * right answer here.
 */
export async function setIncomeSourceActiveAction(
  id: string,
  active: boolean,
): Promise<IncomeActionResult> {
  await requireUser();
  if (!isUuid(id)) return { error: "Unknown income source" };
  await db
    .update(incomeSources)
    .set({ active, updatedAt: new Date() })
    .where(eq(incomeSources.id, id));
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

/**
 * Delete a source — allowed ONLY while nothing has been materialized from it.
 *
 * Once contributions exist, deleting cascades them away while the
 * `investment_transactions` and `holding_lots` they created survive (those FKs
 * are ON DELETE SET NULL by design). The 401k would keep its cost basis with no
 * record of where it came from. Deactivation preserves both.
 */
export async function deleteIncomeSourceAction(id: string): Promise<IncomeActionResult> {
  await requireUser();
  if (!isUuid(id)) return { error: "Unknown income source" };

  const materialized = await countMaterializedContributions({ sourceId: id });
  if (materialized > 0) {
    return {
      error: `This source has ${materialized} materialized contribution${
        materialized === 1 ? "" : "s"
      } backing your cost basis. Deactivate it instead to stop future contributions and keep the history.`,
    };
  }

  await db.delete(incomeSources).where(eq(incomeSources.id, id));
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

/** One deposit stream the form can offer as take-home (ADR-049 §2). Pre-formatted. */
export interface TakeHomeSuggestionView {
  readonly payee: string;
  /** Raw money string, written into the field on "Use". */
  readonly amount: string;
  readonly amountDisplay: string;
  readonly latestDisplay: string;
  readonly latestDate: string;
  readonly matchedPaydays: number;
  readonly expectedPaydays: number;
}

export interface TakeHomeSuggestionResult {
  error?: string;
  suggestions?: readonly TakeHomeSuggestionView[];
}

/**
 * Propose a take-home figure from deposits that landed on this schedule's
 * paydays (ADR-049 §2). Read-only: the user picks, the save action writes.
 *
 * Takes the schedule as typed in the form rather than a saved id, so a source
 * being created — or a cadence being edited — gets a suggestion before save.
 *
 * @param input - The in-progress cadence, anchor, lifespan and (as a ranking
 *   hint only) gross.
 * @returns Up to three candidates, best first; empty when nothing lines up.
 */
export async function suggestTakeHomeAction(input: {
  readonly cadence: string;
  readonly anchorDate: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly grossPerPeriod: string;
}): Promise<TakeHomeSuggestionResult> {
  await requireUser();
  const parsed = takeHomeSuggestionSchema.safeParse(input);
  if (!parsed.success) return { suggestions: [] };

  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(
    Date.parse(`${today}T00:00:00Z`) - (LOOKBACK_DAYS + TOLERANCE_DAYS) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const deposits = await listIncomeDeposits({ from, to: today });
  let candidates: ReturnType<typeof suggestTakeHome>;
  try {
    candidates = suggestTakeHome(parsed.data, deposits, today);
  } catch {
    // A regex-valid but unreal date ("2026-02-30") mid-typing: no suggestion yet.
    return { suggestions: [] };
  }

  return {
    suggestions: candidates.map((c) => ({
      payee: c.payee,
      amount: c.amount,
      amountDisplay: Money.fromString(c.amount, "USD").format(),
      latestDisplay: Money.fromString(c.latestAmount, "USD").format(),
      latestDate: c.latestDate,
      matchedPaydays: c.matchedPaydays,
      expectedPaydays: c.expectedPaydays,
    })),
  };
}

/* -------------------------------------------------------------------- rules */

/**
 * Create or update the 401k contribution rule for a source.
 *
 * Two guards the Zod schema structurally cannot make (they are cross-row
 * database facts, and client-supplied ids are never trusted):
 *   - the account exists and is an `investment` account;
 *   - the holding, when given, belongs to that account.
 *
 * @param _prev - Previous action state (unused; required by useActionState).
 * @param formData - The rule fields, plus `incomeSourceId` and optional `id`.
 * @returns `ok` (with `createdId` on create), or a user-facing `error`.
 */
export async function saveContributionRuleAction(
  _prev: IncomeActionResult,
  formData: FormData,
): Promise<IncomeActionResult> {
  await requireUser();
  const incomeSourceId = field(formData, "incomeSourceId");
  if (!isUuid(incomeSourceId)) return { error: "Unknown income source" };
  const ruleId = field(formData, "id");

  const parsed = contributionRuleSchema.safeParse({
    accountId: field(formData, "accountId"),
    holdingId: field(formData, "holdingId") ?? "",
    employeeBasis: field(formData, "employeeBasis"),
    employeeValue: field(formData, "employeeValue"),
    pretax: field(formData, "pretax"),
    matchBasis: field(formData, "matchBasis"),
    matchValue: field(formData, "matchValue") || "0",
    matchCapPercent: field(formData, "matchCapPercent") ?? "",
    active: field(formData, "active"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const [source] = await db
    .select({ id: incomeSources.id })
    .from(incomeSources)
    .where(eq(incomeSources.id, incomeSourceId))
    .limit(1);
  if (!source) return { error: "Unknown income source" };

  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, parsed.data.accountId), eq(accounts.type, "investment")))
    .limit(1);
  if (!account) return { error: "Pick an investment account to receive the contributions" };

  if (parsed.data.holdingId !== null) {
    const [holding] = await db
      .select({ id: holdings.id })
      .from(holdings)
      .where(
        and(eq(holdings.id, parsed.data.holdingId), eq(holdings.accountId, parsed.data.accountId)),
      )
      .limit(1);
    if (!holding) {
      return { error: "That holding is not in the selected account" };
    }
  }

  if (isUuid(ruleId)) {
    const updated = await db
      .update(retirementContributions)
      .set({ ...parsed.data, incomeSourceId, updatedAt: new Date() })
      .where(eq(retirementContributions.id, ruleId))
      .returning({ id: retirementContributions.id });
    if (updated.length === 0) return { error: "Unknown contribution rule" };
    revalidatePath(SETTINGS_PATH);
    return { ok: true };
  }

  const [created] = await db
    .insert(retirementContributions)
    .values({ ...parsed.data, incomeSourceId })
    .returning({ id: retirementContributions.id });
  revalidatePath(SETTINGS_PATH);
  return { ok: true, createdId: created?.id };
}

/** Pause or resume a rule without disturbing its materialized history. */
export async function setContributionRuleActiveAction(
  id: string,
  active: boolean,
): Promise<IncomeActionResult> {
  await requireUser();
  if (!isUuid(id)) return { error: "Unknown contribution rule" };
  await db
    .update(retirementContributions)
    .set({ active, updatedAt: new Date() })
    .where(eq(retirementContributions.id, id));
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

/** Delete a rule — same history guard as `deleteIncomeSourceAction`. */
export async function deleteContributionRuleAction(id: string): Promise<IncomeActionResult> {
  await requireUser();
  if (!isUuid(id)) return { error: "Unknown contribution rule" };

  const materialized = await countMaterializedContributions({ ruleId: id });
  if (materialized > 0) {
    return {
      error: `This rule has ${materialized} materialized contribution${
        materialized === 1 ? "" : "s"
      } backing your cost basis. Deactivate it instead to stop future contributions and keep the history.`,
    };
  }

  await db.delete(retirementContributions).where(eq(retirementContributions.id, id));
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

/* ----------------------------------------------------------------- backfill */

/**
 * Enqueue the historical contribution backfill.
 *
 * Defining a paycheck almost always describes contributions that ALREADY
 * happened — a start date months or years back. The nightly job now reaches
 * back to `start_date` for a rule with no history, but two cases still need an
 * explicit run: a source that was paused before its history was ever
 * materialized, and a start date edited further into the past after the fact.
 * This is the button for those.
 *
 * Rule 1 at the top of this file still holds: the action does not materialize
 * anything itself. It asks the worker — the sole writer — to do it, and the
 * UNIQUE `(rule, pay_date)` key makes a redundant click a no-op.
 *
 * The jobId is bucketed per-minute so a flurry of clicks collapses into one run
 * (BullMQ dedupes by jobId), mirroring `refreshPricesAction`.
 *
 * @returns `ok`, or a user-facing `error` when the queue is unreachable.
 */
export async function backfillContributionsAction(): Promise<IncomeActionResult> {
  await requireUser();
  const minuteBucket = Math.floor(Date.now() / 60_000);
  try {
    await materializeContributionsQueue.add(
      QUEUE_NAMES.MATERIALIZE_CONTRIBUTIONS,
      { backfill: true },
      { jobId: `backfill-contributions-manual-${minuteBucket}` },
    );
  } catch {
    // The error object can carry a connection string; never surface or log it.
    return { error: "Could not reach the background worker. Is it running?" };
  }
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

/* ------------------------------------------------------------------ preview */

/** What the user sees before saving a rule (P14-15). All values are formatted. */
export interface ContributionPreview {
  readonly cadence: string;
  readonly periodsPerYear: number;
  readonly grossPerPeriod: string;
  readonly employeePerPeriod: string;
  readonly employerPerPeriod: string;
  readonly totalPerPeriod: string;
  readonly annualEmployee: string;
  readonly annualEmployer: string;
  readonly annualGross: string;
  /** Employee ÷ annualized gross across active sources, or null when gross is 0. */
  readonly ratePct: string | null;
  /** True when a fixed employee amount exceeded gross and was clamped to it. */
  readonly employeeClamped: boolean;
  /** True when the employer match was reduced by `matchCapPercent`. */
  readonly matchCapped: boolean;
}

export interface PreviewActionResult {
  error?: string;
  preview?: ContributionPreview;
}

/**
 * Compute what a rule WOULD contribute, without writing anything (P14-15).
 *
 * Read-only by construction: it reads the source's gross, runs the same pure
 * `computeContribution` (P14-06) and `savingsRate` (P14-07) the job and the
 * dashboard use, and returns formatted strings. It never inserts, and it never
 * calls the network.
 *
 * The projected rate treats this source as active even when it is paused —
 * a preview answers "what would this do", and a paused source excluded from the
 * denominator would report a nonsense rate. The card labels it a projection.
 *
 * @param _prev - Previous action state (unused; required by useActionState).
 * @param formData - The in-progress rule fields plus `incomeSourceId`.
 * @returns The computed preview, or a user-facing `error`.
 */
export async function previewContributionAction(
  _prev: PreviewActionResult,
  formData: FormData,
): Promise<PreviewActionResult> {
  await requireUser();
  const parsed = contributionPreviewSchema.safeParse({
    incomeSourceId: field(formData, "incomeSourceId"),
    employeeBasis: field(formData, "employeeBasis"),
    employeeValue: field(formData, "employeeValue"),
    matchBasis: field(formData, "matchBasis"),
    matchValue: field(formData, "matchValue") || "0",
    matchCapPercent: field(formData, "matchCapPercent") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const sources = await db.select().from(incomeSources);
  const source = sources.find((row) => row.id === parsed.data.incomeSourceId);
  if (!source) return { error: "Unknown income source" };

  const cadence = source.cadence as "weekly" | "biweekly" | "semimonthly" | "monthly";
  const gross = Money.fromString(source.grossPerPeriod, source.currency);
  const capPercent =
    parsed.data.matchCapPercent === undefined || parsed.data.matchCapPercent === ""
      ? null
      : parsed.data.matchCapPercent;

  const math: ContributionRuleMath = {
    employeeBasis: parsed.data.employeeBasis,
    employeeValue: parsed.data.employeeValue,
    matchBasis: parsed.data.matchBasis,
    matchValue: parsed.data.matchValue,
    matchCapPercent: capPercent,
  };

  let computed: ComputedContribution;
  let uncapped: ComputedContribution;
  try {
    computed = computeContribution(math, gross);
    uncapped = computeContribution({ ...math, matchCapPercent: null }, gross);
  } catch (err) {
    // The message comes from `computeContribution`'s own validation and names a
    // field, never a dollar figure.
    return { error: (err as Error).message };
  }

  const periods = periodsPerYear(cadence);
  // Annualize by replaying this period's contribution across the year — the
  // same shape `savingsRate` consumes from the materialized ledger, so the
  // preview and the dashboard card cannot disagree on the arithmetic.
  const projected = Array.from({ length: periods }, () => ({
    employeeAmount: computed.employee.toString(),
    employerAmount: computed.employer.toString(),
    currency: source.currency,
  }));
  const rateSources = sources.map((row) => ({
    cadence: row.cadence as typeof cadence,
    grossPerPeriod: row.grossPerPeriod,
    currency: row.currency,
    // Treat the previewed source as active even if paused (see the doc above).
    active: row.id === source.id ? true : row.active,
  }));
  const rate = savingsRate(rateSources, projected, source.currency);

  // The clamp flags are comparisons, not new arithmetic: `computeContribution`
  // already produced both numbers.
  const employeeClamped =
    parsed.data.employeeBasis === "amount" &&
    new Decimal(parsed.data.employeeValue).greaterThan(new Decimal(gross.toString()));

  return {
    preview: {
      cadence,
      periodsPerYear: periods,
      grossPerPeriod: gross.format(),
      employeePerPeriod: computed.employee.format(),
      employerPerPeriod: computed.employer.format(),
      totalPerPeriod: computed.total.format(),
      annualEmployee: rate.annualEmployee.format(),
      annualEmployer: rate.annualEmployer.format(),
      annualGross: rate.annualGross.format(),
      ratePct: rate.ratePct,
      employeeClamped,
      matchCapped: !uncapped.employer.equals(computed.employer),
    },
  };
}
