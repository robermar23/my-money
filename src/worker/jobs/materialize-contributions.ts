import { db } from "@/db/client.ts";
import type { IncomeCadence } from "@/db/schema/income-sources.ts";
import {
  EMPLOYEE_CONTRIBUTION_BASES,
  EMPLOYER_MATCH_BASES,
  INCOME_CADENCES,
  holdingLots,
  holdings,
  incomeContributions,
  incomeSources,
  investmentTransactions,
  retirementContributions,
} from "@/db/schema/index.ts";
import type {
  EmployeeContributionBasis,
  EmployerMatchBasis,
} from "@/db/schema/retirement-contributions.ts";
import {
  type PlannedContribution,
  type PriceLookup,
  planContributions,
} from "@/lib/income/materialize.ts";
import { lotFromBuy } from "@/lib/investments/lots.ts";
import { Money } from "@/lib/money/money.ts";
import { latestCloseOnOrBefore } from "@/lib/prices/store.ts";
import type { Job } from "bullmq";
import { and, eq, gte, lte, sql } from "drizzle-orm";

/**
 * P14-09 (ADR-031) — materialize every DUE payroll contribution into the
 * investment ledger.
 *
 * The whole decision — which pay dates are due, what each contributes, and
 * whether it buys shares or records dollars only — lives in the pure
 * {@link planContributions} planner. This module is the persistence half: it
 * loads active rules, hands the planner `latestCloseOnOrBefore` as its price
 * lookup, and writes what comes back.
 *
 * **Idempotency** is the UNIQUE `(retirement_contribution_id, pay_date)` index,
 * not a bookkeeping flag. Each contribution CLAIMS its slot with an
 * `ON CONFLICT DO NOTHING` ledger insert *before* writing anything derived; if
 * the claim returns no row (a concurrent run got there first), the transaction
 * commits having written nothing. Running the job twice — or overlapping it with
 * the backfill — is therefore a no-op, per CLAUDE.md §Background Jobs.
 *
 * **One transaction per contribution**, not per rule. A pay date is the logical
 * unit of work: a failure on the 40th date of a 52-date backfill leaves the
 * first 39 committed and correct, and the re-run picks up exactly where it
 * stopped. Wrapping the whole rule instead would roll back hours of good work
 * for one bad price row.
 *
 * **Source-scoping is the double-count guard** (ADR-031 §5): every row this job
 * writes carries `source='income'`, and it never reads, updates, or deletes a
 * `source='plaid'`/`'manual'` transaction or lot. See the reconciliation test.
 *
 * No figure handled here — gross, contribution, match — is ever logged. This
 * module makes no network call of its own; the injected price lookup reads the
 * local `prices` table (CLAUDE.md §Privacy).
 */

export interface MaterializeContributionsResult {
  /** Active (rule, source) pairs considered this run. */
  readonly rules: number;
  /** Contributions actually written (post-dedup). */
  readonly created: number;
  /** Of those, ones that bought shares at the pay-date close. */
  readonly priceable: number;
  /** Of those, ones that recorded dollars only (no defensible share count). */
  readonly basisOnly: number;
}

export interface MaterializeContributionsOptions {
  /**
   * Inclusive window start. Defaults per rule: a rule that has never
   * materialized anything reaches back to its source's `start_date`, everything
   * else to {@link DAILY_LOOKBACK_DAYS} before `to`. The backfill (P14-11)
   * passes an epoch floor; the planner clamps to each source's own `start_date`
   * regardless.
   */
  readonly from?: string;
  /** Inclusive window end. Defaults to today. */
  readonly to?: string;
  /** Injected for tests; production reads the local `prices` table. */
  readonly priceLookup?: PriceLookup;
  /** Injected for tests so "today" is deterministic. */
  readonly now?: () => Date;
  /**
   * Also materialize paused rules and paused sources. Default false.
   *
   * Only the backfill sets this. See `planContributions`' own note: `active`
   * gates the FUTURE, `end_date` bounds the past, and a paused source with a
   * past `end_date` still has a real contribution history worth reconstructing.
   */
  readonly includeInactive?: boolean;
}

/**
 * How far back a nightly run looks for a rule that already has history.
 * Comfortably clears a monthly cadence plus a fortnight of missed runs (a NAS
 * that was off), so an ordinary outage self-heals without anyone running the
 * backfill. Re-covering already-written dates costs one indexed lookup each —
 * the UNIQUE key absorbs them.
 *
 * A rule with NO history is not subject to this floor: see
 * {@link ruleWindowStart}. A paycheck defined today routinely describes months
 * of contributions that already happened, and a 45-day floor would silently
 * truncate them to the last three biweekly paydays.
 */
const DAILY_LOOKBACK_DAYS = 45;

const MS_PER_DAY = 86_400_000;

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** `to` shifted back by whole UTC days — no local clock, so DST can't shift it. */
function daysBefore(iso: string, days: number): string {
  return isoDate(new Date(Date.parse(`${iso}T00:00:00Z`) - days * MS_PER_DAY));
}

/**
 * Narrow a `text` column to its CHECK-constrained union.
 *
 * The DB constraint makes the failure branch unreachable; it exists so a value
 * that somehow bypassed the CHECK (a hand-edited row, a botched migration)
 * stops the run loudly instead of silently contributing the wrong dollars.
 */
function assertOneOf<T extends string>(value: string, allowed: readonly T[], column: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${column} violated its CHECK constraint: ${value}`);
  }
  return value as T;
}

/** One active rule joined to its paycheck and (optionally) its target position. */
interface ActiveRule {
  readonly ruleId: string;
  readonly accountId: string;
  readonly holdingId: string | null;
  readonly employeeBasis: EmployeeContributionBasis;
  readonly employeeValue: string;
  readonly matchBasis: EmployerMatchBasis;
  readonly matchValue: string;
  readonly matchCapPercent: string | null;
  readonly cadence: IncomeCadence;
  readonly grossPerPeriod: string;
  readonly currency: string;
  readonly anchorDate: string;
  readonly startDate: string;
  readonly endDate: string | null;
  /** The rule's own pause flag — carried through so the planner gates on truth. */
  readonly ruleActive: boolean;
  /** The paycheck's pause flag. */
  readonly sourceActive: boolean;
  /** NULL when the rule designates no holding ⇒ basis-only. */
  readonly symbol: string | null;
  /** The holding's own provenance — 'plaid' means the sync owns its quantity. */
  readonly holdingSource: string | null;
  readonly securityId: string | null;
}

/**
 * Rules to consider this run.
 *
 * By default: active rules whose income source is also active — inactive on
 * either side pauses materialization without losing the rule or its history.
 * With `includeInactive` (the backfill), paused rules come along too, so a
 * retired paycheck's history can be reconstructed. `end_date` still bounds them
 * in the planner, so a finished source cannot leak contributions into today.
 *
 * @param includeInactive - Include paused rules/sources. Default false.
 * @returns The rules to plan against, joined to their paycheck and position.
 */
async function loadActiveRules(includeInactive = false): Promise<ActiveRule[]> {
  const rows = await db
    .select({
      ruleId: retirementContributions.id,
      accountId: retirementContributions.accountId,
      holdingId: retirementContributions.holdingId,
      employeeBasis: retirementContributions.employeeBasis,
      employeeValue: retirementContributions.employeeValue,
      matchBasis: retirementContributions.matchBasis,
      matchValue: retirementContributions.matchValue,
      matchCapPercent: retirementContributions.matchCapPercent,
      cadence: incomeSources.cadence,
      grossPerPeriod: incomeSources.grossPerPeriod,
      currency: incomeSources.currency,
      anchorDate: incomeSources.anchorDate,
      startDate: incomeSources.startDate,
      endDate: incomeSources.endDate,
      ruleActive: retirementContributions.active,
      sourceActive: incomeSources.active,
      symbol: holdings.symbol,
      holdingSource: holdings.source,
      securityId: holdings.securityId,
    })
    .from(retirementContributions)
    .innerJoin(incomeSources, eq(retirementContributions.incomeSourceId, incomeSources.id))
    .leftJoin(holdings, eq(retirementContributions.holdingId, holdings.id))
    .where(
      includeInactive
        ? undefined
        : and(eq(retirementContributions.active, true), eq(incomeSources.active, true)),
    );

  return rows.map((r) => ({
    ...r,
    employeeBasis: assertOneOf(
      r.employeeBasis,
      EMPLOYEE_CONTRIBUTION_BASES,
      "retirement_contributions.employee_basis",
    ),
    matchBasis: assertOneOf(
      r.matchBasis,
      EMPLOYER_MATCH_BASES,
      "retirement_contributions.match_basis",
    ),
    cadence: assertOneOf(r.cadence, INCOME_CADENCES, "income_sources.cadence"),
  }));
}

/**
 * Rule ids that already have at least one materialized contribution.
 *
 * One grouped query rather than a count per rule: the single user has a handful
 * of rules, but this is also the cheapest correct shape.
 *
 * @returns The set of rule ids with existing history.
 */
async function rulesWithHistory(): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ ruleId: incomeContributions.retirementContributionId })
    .from(incomeContributions);
  return new Set(rows.map((r) => r.ruleId));
}

/**
 * Where a rule's window starts when the caller named no explicit `from`.
 *
 * A rule that has never materialized anything gets its source's `start_date` —
 * a newly-defined paycheck usually describes contributions that already
 * happened, and clamping it to the 45-day lookback would silently drop every
 * one of them (the bug this fixes). A rule with history gets the short lookback,
 * because everything older is already on the books and re-planning it is waste.
 *
 * @param rule - The rule being planned.
 * @param hasHistory - Whether the rule has any materialized contribution.
 * @param defaultFrom - The nightly lookback floor.
 * @returns The inclusive ISO window start for this rule.
 */
function ruleWindowStart(rule: ActiveRule, hasHistory: boolean, defaultFrom: string): string {
  return hasHistory ? defaultFrom : rule.startDate;
}

/** Pay dates already materialized for a rule inside the window. */
async function existingPayDates(ruleId: string, from: string, to: string): Promise<string[]> {
  const rows = await db
    .select({ payDate: incomeContributions.payDate })
    .from(incomeContributions)
    .where(
      and(
        eq(incomeContributions.retirementContributionId, ruleId),
        gte(incomeContributions.payDate, from),
        lte(incomeContributions.payDate, to),
      ),
    );
  return rows.map((r) => r.payDate);
}

/**
 * Write one planned contribution: ledger claim → investment transaction →
 * cost-basis lot → position quantity, all inside a single transaction.
 *
 * @param rule - The rule that produced the contribution.
 * @param planned - The planner's output for one pay date.
 * @returns True when the contribution was written; false when the pay date was
 *   already claimed (the idempotent no-op path).
 */
async function persistContribution(
  rule: ActiveRule,
  planned: PlannedContribution,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // 1. Claim (rule, pay_date) FIRST. Nothing derived is written unless this
    //    insert wins, so the UNIQUE index — not application bookkeeping — is
    //    what makes a re-run a no-op, and a lost race writes nothing at all.
    const [ledger] = await tx
      .insert(incomeContributions)
      .values({
        retirementContributionId: rule.ruleId,
        payDate: planned.payDate,
        grossAmount: planned.gross,
        employeeAmount: planned.employee,
        employerAmount: planned.employer,
        currency: planned.currency,
      })
      .onConflictDoNothing({
        target: [incomeContributions.retirementContributionId, incomeContributions.payDate],
      })
      .returning({ id: incomeContributions.id });
    if (!ledger) return false;

    // 2. The investment transaction. A priceable contribution is a real `buy`;
    //    a basis-only one is a cash deposit. `externalFlow` (P9-10) classifies
    //    BOTH as an external inflow off type/subtype, so TWR/XIRR see the
    //    contribution either way. Buy amounts are negative (cash leaving the
    //    account's sleeve to acquire shares) per the app-wide sign convention;
    //    the deposit is positive. Negation goes through Money, never a string
    //    concat (CLAUDE.md §Money).
    const total = Money.fromString(planned.total, planned.currency);
    const isBuy = planned.kind === "priceable";
    const [txn] = await tx
      .insert(investmentTransactions)
      .values({
        accountId: rule.accountId,
        securityId: rule.securityId,
        type: isBuy ? "buy" : "cash",
        subtype: isBuy ? "contribution" : "deposit",
        tradeDate: planned.payDate,
        quantity: planned.kind === "priceable" ? planned.quantity : null,
        price: planned.kind === "priceable" ? planned.close : null,
        amount: isBuy ? total.negate().toString() : total.toString(),
        name: "Payroll contribution",
        isoCurrencyCode: planned.currency,
        source: "income",
      })
      .returning({ id: investmentTransactions.id });

    // 3. The cost-basis lot — the point of the whole phase. `resolveCostBasis`
    //    (ADR-012) prefers summed lots, so contributed dollars become the
    //    holding's basis with no special-casing anywhere downstream.
    let holdingLotId: string | null = null;
    if (rule.holdingId !== null) {
      const lot =
        planned.kind === "priceable"
          ? lotFromBuy(
              {
                type: "buy",
                quantity: planned.quantity,
                amount: total.negate().toString(),
                tradeDate: planned.payDate,
                isoCurrencyCode: planned.currency,
              },
              rule.holdingId,
              "income",
            )
          : // Basis-only: dollars with NO invented share count (ADR-031). A
            // zero-quantity lot still carries full basis; the position's
            // quantity stays the user's manual entry, and `lotCoverage` shows
            // the gap honestly rather than papering over it.
            {
              holdingId: rule.holdingId,
              acquiredAt: planned.payDate,
              quantity: "0",
              costBasisTotal: total.toString(),
              source: "income" as const,
            };
      if (lot) {
        const [inserted] = await tx
          .insert(holdingLots)
          .values(lot)
          .returning({ id: holdingLots.id });
        holdingLotId = inserted?.id ?? null;
      }
    }

    // 4. Grow the position. Nothing else maintains quantity for a contribution-
    //    funded holding, and valuation is `quantity × close` — without this the
    //    401k's basis would climb while its value stood still.
    //
    //    Skipped when the holding is Plaid-sourced: that sync owns quantity
    //    authoritatively, and incrementing it here would double-count until the
    //    next sync overwrote us. The UI warns about that pairing (P14-12).
    if (planned.kind === "priceable" && rule.holdingId !== null && rule.holdingSource !== "plaid") {
      await tx
        .update(holdings)
        .set({
          // Added in Postgres NUMERIC — exact, and never through a JS float.
          quantity: sql`${holdings.quantity} + ${planned.quantity}::numeric`,
          updatedAt: new Date(),
        })
        .where(eq(holdings.id, rule.holdingId));
    }

    // 5. Point the ledger row at what it created, so a contribution is auditable
    //    back to its transaction and lot.
    await tx
      .update(incomeContributions)
      .set({ investmentTransactionId: txn?.id ?? null, holdingLotId })
      .where(eq(incomeContributions.id, ledger.id));

    return true;
  });
}

/**
 * Materialize every due contribution across all active rules.
 *
 * Shared by the nightly job (a short lookback window) and the run-once backfill
 * (P14-11, an unbounded window) — same code path, so the two can never drift
 * apart in how they compute or write a contribution.
 *
 * @param options - Window, price lookup, and clock overrides.
 * @returns Counts of rules considered and contributions written.
 */
export async function materializeContributions(
  options: MaterializeContributionsOptions = {},
): Promise<MaterializeContributionsResult> {
  const now = (options.now ?? (() => new Date()))();
  const to = options.to ?? isoDate(now);
  const defaultFrom = daysBefore(to, DAILY_LOOKBACK_DAYS);
  const priceLookup: PriceLookup = options.priceLookup ?? latestCloseOnOrBefore;
  const includeInactive = options.includeInactive ?? false;

  const [rules, withHistory] = await Promise.all([
    loadActiveRules(includeInactive),
    // Only needed to widen the window for first-run rules; an explicit `from`
    // (the backfill) already reaches further back than this could.
    options.from === undefined ? rulesWithHistory() : Promise.resolve(new Set<string>()),
  ]);
  let created = 0;
  let priceable = 0;
  let basisOnly = 0;

  for (const rule of rules) {
    const from = options.from ?? ruleWindowStart(rule, withHistory.has(rule.ruleId), defaultFrom);
    const planned = await planContributions({
      rule: {
        employeeBasis: rule.employeeBasis,
        employeeValue: rule.employeeValue,
        matchBasis: rule.matchBasis,
        matchValue: rule.matchValue,
        matchCapPercent: rule.matchCapPercent,
        active: rule.ruleActive,
        symbol: rule.symbol,
      },
      source: {
        cadence: rule.cadence,
        grossPerPeriod: rule.grossPerPeriod,
        currency: rule.currency,
        anchorDate: rule.anchorDate,
        startDate: rule.startDate,
        endDate: rule.endDate,
        active: rule.sourceActive,
      },
      window: { from, to },
      existingPayDates: await existingPayDates(rule.ruleId, from, to),
      priceLookup,
      includeInactive,
    });

    for (const contribution of planned) {
      if (!(await persistContribution(rule, contribution))) continue;
      created += 1;
      if (contribution.kind === "priceable") priceable += 1;
      else basisOnly += 1;
    }
  }

  return { rules: rules.length, created, priceable, basisOnly };
}

/** Job payload. The nightly scheduler sends `{}`; the UI can request a backfill. */
export interface MaterializeContributionsJobData {
  /**
   * Run the full historical walk instead of the nightly window — every pay date
   * from each source's start, paused sources included. Set by the
   * "Backfill history" action on `/settings/income`.
   */
  readonly backfill?: boolean;
}

/**
 * BullMQ processor. Runs nightly at 01:45 — after `fetch-prices-daily` (01:30)
 * so a same-day contribution prices off a same-day close, and before
 * `compute-snapshots-daily` (02:00) so the lots and quantities written here are
 * valued the same night.
 *
 * A job carrying `{ backfill: true }` delegates to the same full historical walk
 * the run-once entry point uses, so the UI button and the CLI cannot drift.
 *
 * @param job - The BullMQ job; `data.backfill` selects the historical walk.
 * @param options - Test seams; production passes nothing.
 * @returns Counts of rules considered and contributions written.
 */
export async function materializeContributionsProcessor(
  job: Job<MaterializeContributionsJobData> | undefined,
  options: MaterializeContributionsOptions = {},
): Promise<MaterializeContributionsResult> {
  if (job?.data?.backfill === true) {
    const { backfillContributionsProcessor } = await import("./backfill-contributions.ts");
    return backfillContributionsProcessor(job, options);
  }
  return materializeContributions(options);
}
