import "server-only";

import { db } from "@/db/client.ts";
import type { AccountSubtype } from "@/db/schema/accounts.ts";
import {
  accounts,
  categories,
  obligationOccurrences,
  scheduledObligations,
} from "@/db/schema/index.ts";
import type { ObligationOccurrenceStatus } from "@/db/schema/obligation-occurrences.ts";
import type {
  ObligationAmountMode,
  ObligationConfidence,
  ObligationDirection,
  ObligationSource,
} from "@/db/schema/scheduled-obligations.ts";
import { tierForSubtype } from "@/lib/advice/cash-tiers.ts";
import { latestBalances } from "@/lib/advice/debt-terms.ts";
import type { ObligationCadence } from "@/lib/schedule/cadence.ts";
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";

/**
 * Reads and writes for the calendar dimension (P16-20, ADR-037).
 *
 * Everything here is a thin query. No money is computed, no date is expanded,
 * nothing is decided — `numeric` columns come back as strings and are handed to
 * `Money` by the pure modules that combine them (CLAUDE.md §Money). Keeping the
 * decisions in [project.ts](./project.ts), [match.ts](./match.ts) and
 * [residual.ts](./residual.ts) is what makes the whole engine testable without a
 * database, which is the property ADR-032 §1 established for advice and this
 * layer inherits.
 *
 * ── Day-zero balances reuse the ONE balance query ──────────────────────────
 * {@link listCashBalancesByTier} calls `latestBalances` from
 * [advice/debt-terms.ts](../advice/debt-terms.ts) rather than writing its own
 * `DISTINCT ON (account_id)` over `account_snapshots`. That is ADR-036 §5's
 * one-implementation rule ("exactly one occurrence expander") applied to reads:
 * a second copy is how "the latest balance" comes to mean two different things
 * on two screens — one honouring a same-day snapshot and one not — with no error
 * anywhere. It also reuses `tierForSubtype`, so "operating cash" means exactly
 * what ADR-033 §1 says it means and cannot drift from what the cash-tier card
 * shows.
 *
 * The import direction is worth naming: cash flow depends on two small,
 * account-level helpers that happen to live under `advice/`. If a third consumer
 * ever appears, they belong in a shared accounts module — but moving them for
 * two would be churn, and duplicating them would be the actual mistake.
 *
 * ── Nothing here logs a figure ─────────────────────────────────────────────
 * Obligation labels name real vendors and every amount is a household's real
 * money (CLAUDE.md §Privacy). No `console` call appears in this file, and errors
 * that reach the user are sentences rather than row dumps.
 */

/** A scheduled obligation joined to the names it points at. */
export interface ObligationRow {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly label: string;
  /** Positive magnitude — the sign is `direction`. */
  readonly expectedAmount: string;
  readonly direction: ObligationDirection;
  readonly currency: string;
  readonly cadence: ObligationCadence;
  readonly anchorDate: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly active: boolean;
  readonly amountMode: ObligationAmountMode;
  readonly source: ObligationSource;
  /** `null` for a manual obligation — it identifies no detected series. */
  readonly detectionKey: string | null;
  /** The loan whose stated terms produced this schedule; `null` otherwise. */
  readonly liabilityId: string | null;
  readonly confidence: ObligationConfidence | null;
  readonly notes: string | null;
}

/** The writable columns of an obligation. `id` present = edit, absent = create. */
export interface ObligationPatch {
  readonly id?: string;
  readonly accountId: string;
  readonly categoryId: string | null;
  readonly label: string;
  readonly expectedAmount: string;
  readonly direction: ObligationDirection;
  readonly currency: string;
  readonly cadence: ObligationCadence;
  readonly anchorDate: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly active: boolean;
  readonly amountMode: ObligationAmountMode;
  readonly source: ObligationSource;
  readonly detectionKey: string | null;
  /**
   * Provenance, never form data. The obligation form does not carry this field
   * and the manual save action re-reads it from the stored row — the same
   * posture `confidence` takes, for the same reason (P16-24).
   */
  readonly liabilityId: string | null;
  readonly confidence: ObligationConfidence | null;
  readonly notes: string | null;
}

/** A materialized occurrence with the obligation columns every caller needs. */
export interface UpcomingOccurrence {
  readonly id: string;
  readonly obligationId: string;
  readonly accountId: string;
  readonly label: string;
  readonly dueDate: string;
  /** Snapshotted at materialization — NOT read through the FK (ADR-037 §5). */
  readonly expectedAmount: string;
  readonly direction: ObligationDirection;
  readonly amountMode: ObligationAmountMode;
  readonly status: ObligationOccurrenceStatus;
  /**
   * Which door the obligation came through. Carried so `/plan/cashflow` can say
   * *why* a bill the household never typed in by hand is on the line (CF-A7).
   */
  readonly source: ObligationSource;
  /** The obligation's `detection_key`, which is what the matcher keys on. */
  readonly payeeKey: string | null;
  readonly matchedTransactionId: string | null;
  readonly matchedAmount: string | null;
}

/** An operating-cash account, before any balance is read. */
export interface OperatingAccountRow {
  readonly accountId: string;
  readonly name: string;
  readonly institution: string;
  readonly subtype: AccountSubtype;
}

/** A cash account and its latest snapshot balance. */
export interface CashBalance {
  readonly accountId: string;
  readonly name: string;
  readonly institution: string;
  readonly subtype: AccountSubtype;
  /** `null` when the account has never been snapshotted — never defaulted to zero. */
  readonly balance: string | null;
  readonly balanceAsOf: string | null;
}

/**
 * An operating-cash account and its latest snapshot balance.
 *
 * The same shape as any other cash account; the name records which tier the
 * caller asked for, and every existing call site reads better for keeping it.
 */
export type OperatingBalance = CashBalance;

/** The household's cash, split by the tier its subtype puts it in. */
export interface CashBalancesByTier {
  /** `checking` / `cash_management` — what the projection walks (ADR-038 §6). */
  readonly operating: readonly CashBalance[];
  /** `savings` / `money_market` — the emergency fund (ADR-033 §1). */
  readonly reserve: readonly CashBalance[];
  /**
   * Open cash accounts whose subtype is `NULL`.
   *
   * A count rather than a total, and deliberately so: an un-triaged balance is
   * money the app cannot place, and totalling it would invite exactly the
   * arithmetic ADR-033 §1 forbids. What the count supports is the honest
   * sentence — *"some of your cash is not classified yet"* — and the link to
   * the screen that fixes it.
   */
  readonly unclassifiedCount: number;
}

/**
 * Every scheduled obligation, newest schedule first within each account.
 *
 * @param opts.includeInactive - When true, deactivated obligations are included.
 *   The candidate filter (P16-12) wants them: a deactivated obligation is one
 *   the user deliberately turned off, and re-proposing it is the re-nagging
 *   ADR-026 rejected. The management UI wants them too, to reactivate.
 * @returns Obligations ordered by account name, then label, then id — stable
 *   across runs so a list does not reshuffle between page loads.
 */
export async function listObligations(
  opts: { includeInactive?: boolean } = {},
): Promise<ObligationRow[]> {
  const rows = await db
    .select({
      id: scheduledObligations.id,
      accountId: scheduledObligations.accountId,
      accountName: accounts.name,
      categoryId: scheduledObligations.categoryId,
      categoryName: categories.name,
      label: scheduledObligations.label,
      expectedAmount: scheduledObligations.expectedAmount,
      direction: scheduledObligations.direction,
      currency: scheduledObligations.currency,
      cadence: scheduledObligations.cadence,
      anchorDate: scheduledObligations.anchorDate,
      startDate: scheduledObligations.startDate,
      endDate: scheduledObligations.endDate,
      active: scheduledObligations.active,
      amountMode: scheduledObligations.amountMode,
      source: scheduledObligations.source,
      detectionKey: scheduledObligations.detectionKey,
      liabilityId: scheduledObligations.liabilityId,
      confidence: scheduledObligations.confidence,
      notes: scheduledObligations.notes,
    })
    .from(scheduledObligations)
    .innerJoin(accounts, eq(accounts.id, scheduledObligations.accountId))
    .leftJoin(categories, eq(categories.id, scheduledObligations.categoryId))
    .where(opts.includeInactive === true ? undefined : eq(scheduledObligations.active, true))
    .orderBy(asc(accounts.name), asc(scheduledObligations.label), asc(scheduledObligations.id));

  return rows.map((row) => ({
    ...row,
    direction: row.direction as ObligationDirection,
    cadence: row.cadence as ObligationCadence,
    amountMode: row.amountMode as ObligationAmountMode,
    source: row.source as ObligationSource,
    confidence: row.confidence as ObligationConfidence | null,
  }));
}

/**
 * Create an obligation, or update an existing one in place.
 *
 * An edit deliberately does NOT rewrite already-materialized occurrences: they
 * snapshot their own `expected_amount` (ADR-037 §5), so raising the rent in June
 * cannot retroactively claim the household paid the new figure in March. The
 * confirm/edit UI states that out loud (P16-25), because otherwise an amount
 * edit looks like it silently failed.
 *
 * @param patch - The obligation's writable columns. With `id`, an update.
 * @returns The stored row's id.
 * @throws If the partial UNIQUE index on `(account_id, detection_key)` rejects a
 *   second confirmation of the same detected series — a double-click confirms
 *   once, which is the index doing its job rather than an error to paper over.
 */
export async function upsertObligation(patch: ObligationPatch): Promise<string> {
  const { id, ...values } = patch;

  if (id !== undefined) {
    const [row] = await db
      .update(scheduledObligations)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(scheduledObligations.id, id))
      .returning({ id: scheduledObligations.id });
    if (!row) throw new Error("upsertObligation: no obligation with that id");
    return row.id;
  }

  const [row] = await db
    .insert(scheduledObligations)
    .values(values)
    .returning({ id: scheduledObligations.id });
  if (!row) throw new Error("upsertObligation: insert returned no row");
  return row.id;
}

/**
 * Stop materializing an obligation without deleting it.
 *
 * Deactivate, never delete (CLAUDE.md §Database). The occurrence history is what
 * explains the household's past months and what the residual attribution reads;
 * deleting the schedule would cascade it away and silently change every window
 * that included those months.
 *
 * @param id - The obligation to pause.
 * @returns True when a row changed; false when the id was already inactive or
 *   does not exist. Deactivating twice is not an error — it is the state asked for.
 */
export async function deactivateObligation(id: string): Promise<boolean> {
  const rows = await db
    .update(scheduledObligations)
    .set({ active: false, updatedAt: new Date() })
    .where(and(eq(scheduledObligations.id, id), eq(scheduledObligations.active, true)))
    .returning({ id: scheduledObligations.id });
  return rows.length > 0;
}

/**
 * Reactivate a paused obligation.
 *
 * The correct route when a stopped series restarts, because it preserves the
 * occurrence history that explains the past — which creating a fresh obligation
 * would not.
 *
 * @param id - The obligation to resume.
 * @returns True when a row changed.
 */
export async function reactivateObligation(id: string): Promise<boolean> {
  const rows = await db
    .update(scheduledObligations)
    .set({ active: true, updatedAt: new Date() })
    .where(and(eq(scheduledObligations.id, id), eq(scheduledObligations.active, false)))
    .returning({ id: scheduledObligations.id });
  return rows.length > 0;
}

/**
 * Materialized occurrences due in an inclusive window.
 *
 * @param from - Inclusive start, `YYYY-MM-DD`.
 * @param to - Inclusive end, `YYYY-MM-DD`.
 * @returns Occurrences ascending by `(due date, label, id)`. Includes inactive
 *   obligations' rows: a bill that came due before the user paused it still
 *   happened, and dropping it would leave a hole in the attribution.
 */
export async function listUpcomingOccurrences(
  from: string,
  to: string,
): Promise<UpcomingOccurrence[]> {
  const rows = await db
    .select({
      id: obligationOccurrences.id,
      obligationId: obligationOccurrences.obligationId,
      accountId: scheduledObligations.accountId,
      label: scheduledObligations.label,
      dueDate: obligationOccurrences.dueDate,
      expectedAmount: obligationOccurrences.expectedAmount,
      direction: scheduledObligations.direction,
      amountMode: scheduledObligations.amountMode,
      status: obligationOccurrences.status,
      source: scheduledObligations.source,
      payeeKey: scheduledObligations.detectionKey,
      matchedTransactionId: obligationOccurrences.matchedTransactionId,
      matchedAmount: obligationOccurrences.matchedAmount,
    })
    .from(obligationOccurrences)
    .innerJoin(
      scheduledObligations,
      eq(scheduledObligations.id, obligationOccurrences.obligationId),
    )
    .where(and(gte(obligationOccurrences.dueDate, from), lte(obligationOccurrences.dueDate, to)))
    .orderBy(
      asc(obligationOccurrences.dueDate),
      asc(scheduledObligations.label),
      asc(obligationOccurrences.id),
    );

  return rows.map((row) => ({
    ...row,
    direction: row.direction as ObligationDirection,
    amountMode: row.amountMode as ObligationAmountMode,
    status: row.status as ObligationOccurrenceStatus,
    source: row.source as ObligationSource,
  }));
}

/**
 * The household's cash accounts and their latest balances, split by tier
 * (ADR-038 §6 for operating, ADR-048 for reserve).
 *
 * Tiering goes through the shipped `tierForSubtype` rather than a subtype list
 * repeated here, so "operating cash" and "the emergency fund" mean exactly what
 * ADR-033 §1 says they mean and cannot drift from what the cash-tier card shows.
 *
 * ── One read, two tiers, and why that is not the sketch CF-B3 drew ─────────
 * PLAN_CASHFLOW_GAPS sketches a `listReserveBalances()` sibling of the old
 * `listOperatingBalances()`. Two sibling functions would each run their own
 * `DISTINCT ON (account_id)` pass over `account_snapshots` — a second snapshot
 * read for a page that already does one, to answer a question about the same
 * accounts. Splitting a single read is strictly cheaper and cannot produce two
 * different opinions about the same balance, which is the property ADR-036 §5's
 * one-implementation rule is actually protecting.
 *
 * ── The projection is NOT widened by this ──────────────────────────────────
 * Returning the reserve tier here does not put it in the projection, and
 * ADR-048 §2 is explicit that it must not: the walk reads `operating` only. A
 * line that quietly absorbed savings could never tell a household it is
 * overspending. The reserve is used for one derived SENTENCE about the number
 * the line already produced.
 *
 * A `null` balance means the account has never been snapshotted. It is returned
 * as `null`, never as `"0.00"` — an unknown balance and an empty account are
 * different statements, and the second one is a lie that moves the number.
 *
 * @returns Both tiers, alphabetical by name within each, plus how many open cash
 *   accounts are still un-triaged. CDs are in neither list: breaking one costs a
 *   penalty, so it is not same-day money for either purpose.
 */
export async function listCashBalancesByTier(): Promise<CashBalancesByTier> {
  const rows = await db
    .select({
      accountId: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      subtype: accounts.subtype,
    })
    .from(accounts)
    // Closed accounts are excluded: a closed checking account pays no bills, and
    // its stale final balance would inflate the opening balance of the walk.
    .where(and(eq(accounts.type, "depository"), isNull(accounts.closedAt)))
    .orderBy(asc(accounts.name));

  const tiered = rows.map((row) => ({
    ...row,
    tier: tierForSubtype(row.subtype as AccountSubtype | null),
  }));
  const wanted = tiered.filter((row) => row.tier === "operating" || row.tier === "reserve");
  const unclassifiedCount = tiered.filter((row) => row.tier === "unclassified").length;

  if (wanted.length === 0) return { operating: [], reserve: [], unclassifiedCount };

  const balances = await latestBalances(wanted.map((row) => row.accountId));
  const byAccount = new Map(balances.map((row) => [row.accountId, row]));

  const withBalance = wanted.map((row) => {
    const snapshot = byAccount.get(row.accountId);
    return {
      tier: row.tier,
      account: {
        accountId: row.accountId,
        name: row.name,
        institution: row.institution,
        subtype: row.subtype as AccountSubtype,
        balance: snapshot?.balance ?? null,
        balanceAsOf: snapshot?.date ?? null,
      },
    };
  });

  return {
    operating: withBalance.filter((row) => row.tier === "operating").map((row) => row.account),
    reserve: withBalance.filter((row) => row.tier === "reserve").map((row) => row.account),
    unclassifiedCount,
  };
}

/**
 * The open operating-cash accounts, with no balance read (CF-A4).
 *
 * Split out of {@link listOperatingBalances} rather than copied: "operating
 * cash" must mean one thing across this layer, and a second `tierForSubtype`
 * filter is exactly how it comes to mean two. The liability-candidate loader
 * needs the accounts and not their balances, and a snapshot read per review-page
 * render for figures nothing displays is a cost with no buyer.
 *
 * @returns One row per open `depository` account whose subtype tiers as
 *   `operating` (ADR-033 §1), alphabetical by name. A `NULL` subtype is never
 *   guessed as checking, so an un-triaged account is absent here.
 */
export async function listOperatingAccounts(): Promise<OperatingAccountRow[]> {
  const rows = await db
    .select({
      accountId: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      subtype: accounts.subtype,
    })
    .from(accounts)
    // Closed accounts are excluded: a closed checking account pays no bills, and
    // its stale final balance would inflate the opening balance of the walk.
    .where(and(eq(accounts.type, "depository"), isNull(accounts.closedAt)))
    .orderBy(asc(accounts.name));

  return rows
    .filter((row) => tierForSubtype(row.subtype as AccountSubtype | null) === "operating")
    .map((row) => ({ ...row, subtype: row.subtype as AccountSubtype }));
}

/**
 * The obligations belonging to the given accounts, for the matcher's sweep.
 *
 * @param accountIds - Accounts to restrict to. Empty short-circuits.
 * @returns Obligation ids and their account, for occurrence lookups.
 */
export async function listObligationIdsForAccounts(
  accountIds: readonly string[],
): Promise<{ id: string; accountId: string }[]> {
  if (accountIds.length === 0) return [];
  return db
    .select({ id: scheduledObligations.id, accountId: scheduledObligations.accountId })
    .from(scheduledObligations)
    .where(inArray(scheduledObligations.accountId, [...accountIds]));
}
