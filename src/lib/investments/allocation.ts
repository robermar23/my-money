import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";

/**
 * Asset-allocation computation (Phase 5, ADR-013). Groups valued holdings into
 * part-of-whole slices for the Recharts donut. Percents are computed with
 * Decimal and rounded so the slices sum to exactly 100.00 (the rounding
 * remainder lands on the largest slice — avoids a "99.99%" donut).
 */

/** Minimal valued-holding shape — decoupled from the server-only valuation module. */
export interface ValuedHolding {
  readonly assetClass: string;
  readonly accountId: string;
  readonly value: Money;
}

export interface AllocationSlice {
  readonly label: string;
  readonly value: Money;
  /** Share of the total, 2dp string. Slices sum to exactly "100.00". */
  readonly percent: string;
}

/**
 * Turn a label→value map into percent-balanced slices, largest first.
 * Zero-value groups are dropped; a zero total yields an empty array.
 */
function buildSlices(
  groups: ReadonlyMap<string, Money>,
  currency: string,
  labelFor: (key: string) => string,
): AllocationSlice[] {
  const entries = [...groups.entries()].filter(([, value]) => !value.isZero());
  if (entries.length === 0) return [];

  const total = Money.sum(
    entries.map(([, value]) => value),
    currency,
  );
  if (total.isZero()) return [];

  // Largest first (stable for ties → preserves insertion order).
  entries.sort(([, a], [, b]) => new Decimal(b.toString()).comparedTo(new Decimal(a.toString())));

  const totalDec = new Decimal(total.toString());
  const rows = entries.map(([key, value]) => ({
    label: labelFor(key),
    value,
    pct: new Decimal(value.toString()).dividedBy(totalDec).times(100).toDecimalPlaces(2),
  }));

  // Push the rounding remainder onto the largest (first) slice.
  const sumRounded = rows.reduce((acc, r) => acc.plus(r.pct), new Decimal(0));
  const remainder = new Decimal(100).minus(sumRounded);
  const largest = rows[0];
  if (!remainder.isZero() && largest) {
    largest.pct = largest.pct.plus(remainder);
  }

  return rows.map((r) => ({ label: r.label, value: r.value, percent: r.pct.toFixed(2) }));
}

function sumByKey(
  valued: readonly ValuedHolding[],
  keyOf: (h: ValuedHolding) => string,
  currency: string,
): Map<string, Money> {
  const groups = new Map<string, Money>();
  for (const h of valued) {
    const key = keyOf(h);
    const prev = groups.get(key) ?? Money.zero(currency);
    groups.set(key, prev.add(h.value));
  }
  return groups;
}

/** Allocation grouped by `asset_class`. */
export function allocationByAssetClass(
  valued: readonly ValuedHolding[],
  currency: string,
): AllocationSlice[] {
  return buildSlices(
    sumByKey(valued, (h) => h.assetClass, currency),
    currency,
    (k) => k,
  );
}

/** Allocation grouped by account, with optional id→name resolution. */
export function allocationByAccount(
  valued: readonly ValuedHolding[],
  currency: string,
  nameByAccountId?: Readonly<Record<string, string>>,
): AllocationSlice[] {
  return buildSlices(
    sumByKey(valued, (h) => h.accountId, currency),
    currency,
    (id) => nameByAccountId?.[id] ?? id,
  );
}
