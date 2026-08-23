import type { IncomeCadence } from "@/db/schema/income-sources.ts";
import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";
import { type ContributionRuleInput, computeContribution } from "./contribution.ts";
import { payDatesBetween } from "./schedule.ts";

/**
 * Contribution materialization PLANNER (P14-08, ADR-031).
 *
 * Pure: every input is injected, including the price lookup, so the whole
 * decision — which pay dates are due, what each one contributes, and whether it
 * buys shares or records dollars only — is unit-testable without a database.
 * The job (P14-09) does nothing but persist what this returns, inside one
 * transaction.
 *
 * The priceable / basis-only split is the heart of ADR-031:
 *
 *   - **priceable** — the rule designates a holding with a symbol AND a close
 *     exists on (or before) the pay date. We buy `total ÷ close` shares, so the
 *     contribution lands as a real `investment_transactions` buy + a
 *     `holding_lots` lot and flows through the EXISTING cost-basis precedence
 *     (ADR-012) into gain/loss, TWR, XIRR, allocation, and snapshots.
 *   - **basis-only** — no holding, no symbol, or no price (a typical opaque
 *     institutional 401k fund, or a backfill date older than our price history).
 *     Dollars are recorded as basis with NO invented share count. Making up a
 *     quantity would produce a confidently wrong position; declining to is the
 *     honest failure mode.
 *
 * Idempotency lives with the caller: pass the pay dates already in
 * `income_contributions` as `existingPayDates` and they are skipped here, while
 * the UNIQUE (rule, pay_date) constraint remains the real guarantee if two runs
 * race.
 */

/** The income-source fields the planner reads — a subset of `IncomeSource`. */
export interface MaterializeSource {
  readonly cadence: IncomeCadence;
  readonly grossPerPeriod: string;
  readonly currency: string;
  /** A known pay date; phases the schedule. */
  readonly anchorDate: string;
  /** No contribution is materialized before this date. */
  readonly startDate: string;
  /** Last day the source pays, or null while it is ongoing. */
  readonly endDate: string | null;
  readonly active: boolean;
}

/** The rule fields the planner reads — the math subset plus targeting + state. */
export interface MaterializeRule extends ContributionRuleInput {
  readonly active: boolean;
  /**
   * The designated holding's symbol, or null for basis-only. A holding with no
   * symbol (an opaque fund) is basis-only too — pass null for it.
   */
  readonly symbol: string | null;
}

/**
 * `(symbol, payDate) → closing price string | null`.
 *
 * The job supplies `latestCloseOnOrBefore`; tests supply a stub. May be sync or
 * async — the planner awaits either. Returning null means "no defensible price",
 * which downgrades that pay date to basis-only.
 */
export type PriceLookup = (
  symbol: string,
  payDate: string,
) => Promise<string | null> | string | null;

interface PlannedBase {
  /** `YYYY-MM-DD` — half of the (rule, pay_date) idempotency key. */
  readonly payDate: string;
  /** Gross for the period, snapshotted so history survives a later rate change. */
  readonly gross: string;
  readonly employee: string;
  readonly employer: string;
  /** employee + employer — the dollars invested, and the lot's cost basis. */
  readonly total: string;
  readonly currency: string;
}

/**
 * A contribution ready to persist. Discriminated on `kind` so the job cannot
 * reach for a `quantity` that a basis-only contribution does not have.
 */
export type PlannedContribution =
  | (PlannedBase & {
      readonly kind: "priceable";
      readonly symbol: string;
      /** Close used for the buy — `latestCloseOnOrBefore(symbol, payDate)`. */
      readonly close: string;
      /** `total ÷ close`, at the lots table's 8-decimal scale. */
      readonly quantity: string;
    })
  | (PlannedBase & {
      readonly kind: "basis-only";
      /** Present when a symbol exists but had no usable price on the pay date. */
      readonly symbol: string | null;
    });

export interface PlanContributionsInput {
  readonly rule: MaterializeRule;
  readonly source: MaterializeSource;
  /** Inclusive window to materialize; the job passes `[lookback, today]`. */
  readonly window: { readonly from: string; readonly to: string };
  /** Pay dates already in `income_contributions` for this rule. */
  readonly existingPayDates: Iterable<string>;
  readonly priceLookup: PriceLookup;
  /**
   * Plan for paused rules/sources too. Default false.
   *
   * `active` answers "keep creating contributions going forward?" — it is NOT a
   * claim that the past didn't happen. Conflating the two is what makes the
   * plan's own prescribed job-change workflow (end-date the old source, start a
   * new one) silently lose the old job's entire contribution history.
   *
   * The nightly job leaves this false: a paused source must not accrue new
   * contributions. The backfill sets it true, because reconstructing history for
   * a finished paycheck is exactly its job. `end_date` — not `active` — is what
   * stops a retired source from materializing into the present.
   */
  readonly includeInactive?: boolean;
}

/** Quantity scale of `holding_lots.quantity` — NUMERIC(28,8). */
const QUANTITY_SCALE = 8;

/**
 * A price we can actually divide by, or null. Guards the three ways a close can
 * be unusable: absent, not a number at all, and zero/negative.
 */
function toPositiveDecimal(close: string | null): Decimal | null {
  if (close === null) return null;
  let decimal: Decimal;
  try {
    decimal = new Decimal(close);
  } catch {
    return null;
  }
  if (!decimal.isFinite() || decimal.lessThanOrEqualTo(0)) return null;
  return decimal;
}

/**
 * Plan every contribution due for a rule inside a window.
 *
 * The effective window is the caller's window intersected with the source's own
 * life: nothing before `start_date`, nothing after `end_date`. An inactive rule
 * or source plans nothing at all — deactivating is how the user pauses
 * materialization — unless `includeInactive` is set, which is how the backfill
 * reconstructs a retired paycheck's history.
 *
 * Zero-dollar pay dates are skipped. A 0% rule would otherwise write an empty
 * ledger row every payday forever, adding noise to the audit trail and nothing
 * to cost basis.
 *
 * @param input - Rule, source, window, already-materialized dates, price lookup.
 * @returns Contributions to persist, ascending by pay date. Empty when nothing
 *   is due.
 */
export async function planContributions(
  input: PlanContributionsInput,
): Promise<PlannedContribution[]> {
  const { rule, source, window, existingPayDates, priceLookup } = input;
  if (!(input.includeInactive ?? false) && (!rule.active || !source.active)) return [];

  // Intersect the requested window with the source's life. String comparison is
  // safe and exact on zero-padded ISO dates.
  const from = window.from > source.startDate ? window.from : source.startDate;
  const to = source.endDate !== null && source.endDate < window.to ? source.endDate : window.to;
  if (from > to) return [];

  const already = new Set(existingPayDates);
  const gross = Money.fromString(source.grossPerPeriod, source.currency);
  const { employee, employer, total } = computeContribution(rule, gross);
  if (total.isZero()) return [];

  const base = {
    gross: gross.toString(),
    employee: employee.toString(),
    employer: employer.toString(),
    total: total.toString(),
    currency: source.currency,
  };

  const planned: PlannedContribution[] = [];
  for (const payDate of payDatesBetween(source.cadence, source.anchorDate, from, to)) {
    if (already.has(payDate)) continue;

    if (rule.symbol === null) {
      planned.push({ kind: "basis-only", payDate, symbol: null, ...base });
      continue;
    }

    const close = await priceLookup(rule.symbol, payDate);
    // A null, unparseable, or non-positive close cannot divide into a share
    // count — record the dollars and move on rather than inventing a position.
    const closeDecimal = toPositiveDecimal(close);
    if (closeDecimal === null) {
      planned.push({ kind: "basis-only", payDate, symbol: rule.symbol, ...base });
      continue;
    }

    planned.push({
      kind: "priceable",
      payDate,
      symbol: rule.symbol,
      close: closeDecimal.toString(),
      quantity: new Decimal(base.total)
        .dividedBy(closeDecimal)
        .toDecimalPlaces(QUANTITY_SCALE)
        .toString(),
      ...base,
    });
  }
  return planned;
}
