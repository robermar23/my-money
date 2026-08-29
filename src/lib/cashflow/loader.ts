import "server-only";

import { db } from "@/db/client.ts";
import { transactions } from "@/db/schema/index.ts";
import { observedNetIncome } from "@/lib/advice/net-income.ts";
import type { InputUsed } from "@/lib/advice/types.ts";
import { spendingSummary } from "@/lib/analytics/spending.ts";
import { loadHousehold } from "@/lib/household/queries.ts";
import { loadIncomeSettings } from "@/lib/income/queries.ts";
import { periodsPerYear } from "@/lib/income/schedule.ts";
import { Money } from "@/lib/money/money.ts";
import { min } from "drizzle-orm";
import { loadCandidates } from "./candidate-loader.ts";
import { DEFAULT_CASH_FLOOR, DEFAULT_PROJECTION_HORIZON_DAYS } from "./constants.ts";
import {
  type IncomeSourceInput,
  type ObligationInput,
  expandIncomeEvents,
  expandObligationEvents,
} from "./events.ts";
import { projectDailyBalance } from "./project.ts";
import type { ObligationRow, OperatingBalance, UpcomingOccurrence } from "./queries.ts";
import { listObligations, listOperatingBalances, listUpcomingOccurrences } from "./queries.ts";
import { residualDailyRate } from "./residual.ts";
import { projectionStatus } from "./status.ts";
import type { ProjectionResult } from "./types.ts";

/**
 * The cash-flow layer's one assembly function (P16-30, ADR-032 §1 applied to
 * Phase 16).
 *
 * Mirrors `loadFinancialSnapshot`: this reads, everything downstream is pure.
 * The engine modules — [events](./events.ts), [residual](./residual.ts),
 * [project](./project.ts), [safe-to-spend](./safe-to-spend.ts),
 * [status](./status.ts) — take numbers and give numbers back, and this is the
 * only place that knows Postgres exists.
 *
 * **Landed in Batch 6 rather than Batch 7, deliberately.** PLAN16 lists it as
 * P16-30, but P16-27's daily job has to evaluate `projected_shortfall`, and a
 * shortfall is a fact about a projection. The alternative was shipping an alert
 * type in the `alerts` CHECK with no code path that could ever produce one —
 * a dead branch in production for the length of a batch. Building the assembly
 * once, here, is the cheaper and more honest order.
 *
 * ── Every methodology decision below is ADR-038's, not a new one ───────────
 *   §2 The discretionary rate is a RESIDUAL: trailing observed expense MINUS
 *      the expense attributable to confirmed obligations. Adding a total-spend
 *      run-rate to a dated mortgage charges the mortgage twice and silently
 *      understates safe-to-spend. Attribution uses the occurrence MATCH, so the
 *      subtraction is exact rather than estimated.
 *   §3 Inflows come from observed take-home, never `gross_per_period`.
 *   §5 Safe-to-spend is `min(closing) − floor`, clamped, computed in the engine.
 *   §6 Operating cash only — `checking`/`cash_management`, via the shipped
 *      `tierForSubtype`, so account selection cannot mean two things.
 *   §7 Degradation is a named level with the missing input linked.
 *   §8 Every figure carries its inputs, in the shipped `InputUsed` shape.
 *
 * ── What this module decides that the ADR did not spell out ────────────────
 * Three things, each stated where it happens:
 *
 *   1. **Take-home is split evenly across pay events**, because
 *      `observedNetIncome` returns one household-level monthly median and
 *      `gross_per_period` — the only per-source weight available — is exactly
 *      the input §3 bans. See {@link netPerPeriod}.
 *   2. **Already-settled occurrences are removed from the projection.** A
 *      `skipped` bill is not happening and a `matched` one already posted; both
 *      would otherwise be charged to a future day a second time.
 *   3. **Candidates are only counted when there are no confirmed obligations**,
 *      because that count exists solely to drive the run-rate-only fix link, and
 *      detection over two years of transactions is not free.
 *
 * Nothing here makes a network call, and no figure is logged (CLAUDE.md
 * §Privacy).
 */

const CURRENCY = "USD";
const MS_PER_DAY = 86_400_000;

/**
 * How far back the residual rate looks.
 *
 * Ninety days rather than a year: the rate describes what this household spends
 * *now*, and a twelve-month window drags last winter's heating bills into a
 * March projection.
 *
 * Not exactly the same span as the honesty gate, and the difference is worth
 * naming: `MIN_HISTORY_MONTHS` is three WHOLE months (~91.3 days), so a
 * household sitting right on ninety days has a full rate window and is still
 * one or two days short of the gate. It degrades to `insufficient_history` for
 * those two days — the conservative direction, and the one that never states a
 * rate the data cannot support.
 */
export const RESIDUAL_WINDOW_DAYS = 90;

export interface LoadCashFlowOptions {
  /** `YYYY-MM-DD`. Explicit so a run is reproducible; defaults to today. */
  readonly today?: string;
  /** Instant for snooze evaluation inside candidate detection. Defaults to now. */
  readonly now?: Date;
}

/** The assembled cash-flow picture, projection included. */
export interface CashFlowSnapshot {
  /** The projection itself — points, low-water mark, safe-to-spend, audit trail. */
  readonly projection: ProjectionResult;
  /** Day zero. Inclusive horizon start. */
  readonly from: string;
  /** Inclusive horizon end. */
  readonly to: string;
  /** Operating-cash accounts and their latest snapshot balances (ADR-038 §6). */
  readonly operating: readonly OperatingBalance[];
  /** Every confirmed obligation, inactive ones included, for the schedule list. */
  readonly obligations: readonly ObligationRow[];
  /** Materialized occurrences inside the horizon, for the calendar. */
  readonly occurrences: readonly UpcomingOccurrence[];
  /** Detected candidates awaiting review; `0` unless the count was needed. */
  readonly candidateCount: number;
  /**
   * Whole months of transaction history behind the rate.
   *
   * Carried on the snapshot rather than left inside `inputsUsed` so the page can
   * say "you have 2 months of 3" without parsing a string out of its own audit
   * trail — a UI reading its own rendered copy back is a defect waiting for the
   * day someone rewords it.
   */
  readonly historyMonths: number;
}

/**
 * Assemble everything the projection needs and run it.
 *
 * @param options - The reference date and clock. Both default to now.
 * @returns The projection plus the rows the delivery surfaces render beside it.
 * @throws If a stored schedule holds a malformed date or an unknown cadence —
 *   a bad row stops the run loudly rather than quietly dropping a bill out of a
 *   number the household spends against.
 */
export async function loadCashFlow(options: LoadCashFlowOptions = {}): Promise<CashFlowSnapshot> {
  const now = options.now ?? new Date();
  const today = options.today ?? isoDate(now);

  const [household, operating, obligations, income, earliestTxn] = await Promise.all([
    loadHousehold(),
    listOperatingBalances(),
    listObligations({ includeInactive: true }),
    loadIncomeSettings(),
    earliestTransactionDate(),
  ]);

  const cashFloor = household.profile?.cashFloor ?? DEFAULT_CASH_FLOOR;
  const horizonDays = household.profile?.projectionHorizonDays ?? DEFAULT_PROJECTION_HORIZON_DAYS;
  const from = today;
  const to = shiftDays(today, horizonDays - 1);

  const active = obligations.filter((row) => row.active);
  const inputsUsed: InputUsed[] = [];

  // ── Day zero ─────────────────────────────────────────────────────────────
  // An account that has never been snapshotted contributes NOTHING and is named
  // as a missing input, rather than being read as zero. An unknown balance and
  // an empty account are different statements, and the second is a lie that
  // moves the number the family acts on.
  let opening = Money.zero(CURRENCY);
  const unsnapshotted: string[] = [];
  for (const account of operating) {
    if (account.balance === null) {
      unsnapshotted.push(account.name);
      continue;
    }
    opening = opening.add(Money.fromString(account.balance, CURRENCY));
  }

  inputsUsed.push({
    label: "Operating cash today",
    value: operating.length === 0 ? null : opening.format(),
    kind: "money",
    source:
      operating.length === 0
        ? "No checking or cash-management account is classified"
        : `Latest balance across ${operating.length} operating account${operating.length === 1 ? "" : "s"}`,
    missing: operating.length === 0,
    href: "/accounts",
  });
  if (unsnapshotted.length > 0) {
    inputsUsed.push({
      label: "Accounts with no balance yet",
      value: unsnapshotted.join(", "),
      kind: "text",
      source: "Excluded from the opening balance rather than counted as zero",
      missing: true,
      href: "/accounts",
    });
  }

  // ── The residual rate (ADR-038 §2) ───────────────────────────────────────
  const windowFrom = shiftDays(today, -(RESIDUAL_WINDOW_DAYS - 1));
  const [spend, pastOccurrences, netIncome] = await Promise.all([
    spendingSummary({ from: windowFrom, to: today }),
    listUpcomingOccurrences(windowFrom, today),
    observedNetIncome({ from: windowFrom, to: today }),
  ]);

  const attributed = attributableOutflow(pastOccurrences);
  const residual = residualDailyRate(spend.expense, attributed.toString(), RESIDUAL_WINDOW_DAYS);

  inputsUsed.push(
    {
      label: "Everyday spending, per day",
      value: Money.fromString(residual.dailyRate, CURRENCY).format(),
      kind: "money",
      source: `${RESIDUAL_WINDOW_DAYS} days of spend, minus the bills already on your calendar`,
      href: "/analysis",
    },
    {
      label: "Bills already accounted for",
      value: residual.coverage === null ? null : formatPercent(residual.coverage),
      kind: "percent",
      source:
        residual.coverage === null
          ? "No spending observed in the window"
          : "Share of trailing spend matched to a confirmed bill",
      href: "/plan/cashflow/review",
    },
  );

  // ── Inflows (ADR-038 §3) ─────────────────────────────────────────────────
  const activeSources = income.sources.filter((source) => source.active);
  const perPeriod = netPerPeriod(activeSources, netIncome.trailingMedian);

  inputsUsed.push({
    label: "Take-home per month",
    value:
      netIncome.trailingMedian === null
        ? null
        : Money.fromString(netIncome.trailingMedian, CURRENCY).format(),
    kind: "money",
    source:
      netIncome.trailingMedian === null
        ? "No income categories with activity in the window"
        : `Median of ${netIncome.basisMonths} month${netIncome.basisMonths === 1 ? "" : "s"} of deposits, never gross pay`,
    missing: netIncome.trailingMedian === null,
    href: "/settings/income",
  });

  // ── Events ───────────────────────────────────────────────────────────────
  const horizonOccurrences = await listUpcomingOccurrences(from, to);
  const settled = new Set(
    horizonOccurrences
      .filter((row) => row.status === "skipped" || row.status === "matched")
      .map((row) => `${row.obligationId} ${row.dueDate}`),
  );

  const obligationEvents = expandObligationEvents(active.map(toObligationInput), from, to).filter(
    (event) => !settled.has(`${event.obligationId} ${event.date}`),
  );
  const incomeEvents = expandIncomeEvents(
    activeSources.map(toIncomeSourceInput),
    perPeriod,
    from,
    to,
  );

  // ── Honesty ladder (ADR-038 §7) ──────────────────────────────────────────
  const historyMonths = monthsSince(earliestTxn, today);
  const candidateCount =
    active.length === 0 ? (await loadCandidates({ today, now: options.now })).length : 0;
  const status = projectionStatus({
    operatingAccountCount: operating.length,
    historyMonths,
    confirmedObligationCount: active.length,
    candidateCount,
  });
  if (status.missing !== null) inputsUsed.push(status.missing);

  inputsUsed.push({
    label: "Projection horizon",
    value: `${horizonDays} days`,
    kind: "count",
    source: "A low-water mark without its window is not a fact",
    href: "/settings/household",
  });

  const projection = projectDailyBalance({
    from,
    to,
    openingBalance: opening.toString(),
    events: [...obligationEvents, ...incomeEvents],
    // Under three months of data there is no honest rate, so the line carries
    // the dated events alone rather than a number invented from six weeks.
    residual:
      status.status === "insufficient_history"
        ? { dailyRate: "0.00", coverage: residual.coverage, clampedAtZero: false }
        : residual,
    cashFloor,
    status: status.status,
    inputsUsed,
  });

  return {
    projection,
    from,
    to,
    operating,
    obligations,
    occurrences: horizonOccurrences,
    candidateCount,
    historyMonths,
  };
}

/**
 * Expense in the window attributable to confirmed obligations (ADR-038 §2).
 *
 * Matched occurrences count at what ACTUALLY posted; unmatched-but-confirmed
 * ones at their snapshotted `expected_amount`. `skipped` occurrences count for
 * nothing — the household said that bill was not happening, and subtracting it
 * would over-attribute and inflate safe-to-spend.
 *
 * @param occurrences - Occurrences due inside the residual window.
 * @returns The total attributable outflow, as a positive magnitude.
 */
function attributableOutflow(occurrences: readonly UpcomingOccurrence[]): Money {
  let total = Money.zero(CURRENCY);
  for (const occurrence of occurrences) {
    if (occurrence.direction !== "outflow") continue;
    if (occurrence.status === "skipped") continue;
    const amount =
      occurrence.status === "matched" && occurrence.matchedAmount !== null
        ? Money.fromString(occurrence.matchedAmount, CURRENCY).abs()
        : Money.fromString(occurrence.expectedAmount, CURRENCY).abs();
    total = total.add(amount);
  }
  return total;
}

/**
 * Observed take-home, split across every pay event the active sources produce.
 *
 * ADR-038 §3 names the amount (observed net) and the dates (each source's own
 * cadence) but not how one household-level median divides across several
 * paychecks. The only per-source weight the schema offers is
 * `gross_per_period`, which is precisely the input §3 forbids — projecting
 * gross overstates every inflow by the whole withholding stack, and using it as
 * a *ratio* would smuggle the same distortion in through the side door.
 *
 * So the split is even per pay event: annual take-home divided by the total
 * number of pay events a year across all active sources. Two unequal paychecks
 * are therefore each projected at their average, which shifts money between pay
 * dates but never changes the monthly total — and the low-water mark, which is
 * what the household acts on, moves by at most the gap between two paydays.
 * Division is `Money.divFloor`: erring low on an INFLOW is the safe direction.
 *
 * @param sources - Active income sources.
 * @param monthlyMedian - `observedNetIncome`'s trailing median, or `null`.
 * @returns Source id → per-period take-home. Empty when there is no median, so
 *   `expandIncomeEvents` skips every source rather than projecting a $0 paycheck.
 */
function netPerPeriod(
  sources: readonly { id: string; cadence: string }[],
  monthlyMedian: string | null,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (monthlyMedian === null || sources.length === 0) return out;

  const median = Money.fromString(monthlyMedian, CURRENCY);
  if (median.isNegative() || median.isZero()) return out;

  let eventsPerYear = 0;
  for (const source of sources) {
    eventsPerYear += periodsPerYear(source.cadence as never);
  }
  if (eventsPerYear === 0) return out;

  const perEvent = median.mul(12).divFloor(eventsPerYear);
  for (const source of sources) out.set(source.id, perEvent.toString());
  return out;
}

/** An `ObligationRow` narrowed to what the event expander reads. */
function toObligationInput(row: ObligationRow): ObligationInput {
  return {
    id: row.id,
    label: row.label,
    expectedAmount: row.expectedAmount,
    direction: row.direction,
    amountMode: row.amountMode,
    cadence: row.cadence,
    anchorDate: row.anchorDate,
    startDate: row.startDate,
    endDate: row.endDate,
    active: row.active,
  };
}

/** An income source narrowed to what the event expander reads. */
function toIncomeSourceInput(row: {
  id: string;
  name: string;
  cadence: string;
  anchorDate: string;
  startDate: string;
  endDate: string | null;
  active: boolean;
}): IncomeSourceInput {
  return {
    id: row.id,
    name: row.name,
    cadence: row.cadence as IncomeSourceInput["cadence"],
    anchorDate: row.anchorDate,
    startDate: row.startDate,
    endDate: row.endDate,
    active: row.active,
  };
}

/** The oldest posted transaction, or `null` on an empty install. */
async function earliestTransactionDate(): Promise<string | null> {
  const [row] = await db
    .select({ earliest: min(transactions.postedAt) })
    .from(transactions)
    .limit(1);
  return row?.earliest ?? null;
}

/** Whole months of history, floored. `null` earliest ⇒ zero months. */
function monthsSince(earliest: string | null, today: string): number {
  if (earliest === null) return 0;
  const days = Math.floor(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${earliest}T00:00:00Z`)) / MS_PER_DAY,
  );
  if (!Number.isFinite(days) || days < 0) return 0;
  // 30.44 days is the mean month; flooring keeps "just under three months" from
  // reading as three, which is the gate `insufficient_history` turns on.
  return Math.floor(days / 30.44);
}

/**
 * A `[0,1]` decimal fraction as a display percentage.
 *
 * The only float in this module, and deliberately not a violation of CLAUDE.md
 * §Money: coverage is a dimensionless RATIO, not a money value, nothing
 * downstream does arithmetic on the result, and this is the display edge — the
 * one place `Number` is allowed. A coverage figure a tenth of a percent out
 * changes no decision; a balance a cent out does.
 */
function formatPercent(fraction: string): string {
  return `${(Number.parseFloat(fraction) * 100).toFixed(1)}%`;
}

/** `iso` shifted by whole UTC days. A DST transition cannot move a due date. */
function shiftDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
