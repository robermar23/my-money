import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";

/**
 * Asset-allocation computation (Phase 5, ADR-013). Groups valued holdings into
 * part-of-whole slices for the Recharts donut. Percents are computed with
 * Decimal and rounded so the slices sum to exactly 100.00 (the rounding
 * remainder lands on the largest slice — avoids a "99.99%" donut).
 */

/** Bucket label for holdings missing the dimension's metadata (P9-15). */
export const UNCLASSIFIED = "Unclassified";

/** Minimal valued-holding shape — decoupled from the server-only valuation module. */
export interface ValuedHolding {
  readonly assetClass: string;
  readonly accountId: string;
  readonly value: Money;
  /** Enrichment metadata (ADR-020); null/undefined → "Unclassified" bucket. */
  readonly sector?: string | null;
  readonly region?: string | null;
  readonly assetType?: string | null;
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

/** Normalize an optional metadata field into a non-empty bucket key. */
function bucket(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : UNCLASSIFIED;
}

/** Allocation grouped by GICS sector; null/blank sectors fall in "Unclassified". */
export function allocationBySector(
  valued: readonly ValuedHolding[],
  currency: string,
): AllocationSlice[] {
  return buildSlices(
    sumByKey(valued, (h) => bucket(h.sector), currency),
    currency,
    (k) => k,
  );
}

/** Allocation grouped by country/region; null/blank regions fall in "Unclassified". */
export function allocationByRegion(
  valued: readonly ValuedHolding[],
  currency: string,
): AllocationSlice[] {
  return buildSlices(
    sumByKey(valued, (h) => bucket(h.region), currency),
    currency,
    (k) => k,
  );
}

/** Allocation grouped by normalized asset type; null/blank types → "Unclassified". */
export function allocationByAssetType(
  valued: readonly ValuedHolding[],
  currency: string,
): AllocationSlice[] {
  return buildSlices(
    sumByKey(valued, (h) => bucket(h.assetType), currency),
    currency,
    (k) => k,
  );
}

/** A single position for the concentration table. */
export interface ConcentrationInput {
  readonly label: string;
  readonly value: Money;
}

export interface ConcentrationRow {
  readonly label: string;
  readonly value: Money;
  /** Share of the whole portfolio (2dp string). Rows need NOT sum to 100. */
  readonly percent: string;
}

export interface Concentration {
  /** The top-N positions, largest first. */
  readonly top: ConcentrationRow[];
  /** Combined share of the top-N positions (2dp string). */
  readonly topPercent: string;
}

/**
 * Portfolio concentration: the top-N positions and the share of total value
 * they represent. Unlike `buildSlices`, percents are each a fraction of the
 * *whole* portfolio (so a top-5 of a diversified book sums to < 100) — the
 * point is to surface single-name risk, not part-of-whole.
 *
 * @param positions - Valued positions (one per holding).
 * @param currency - Currency to total in.
 * @param topN - How many leading positions to return (default 10).
 * @returns The top-N rows + their combined percent. Empty when total is zero.
 */
export function concentration(
  positions: readonly ConcentrationInput[],
  currency: string,
  topN = 10,
): Concentration {
  const nonZero = positions.filter((p) => !p.value.isZero());
  const total = Money.sum(
    nonZero.map((p) => p.value),
    currency,
  );
  if (total.isZero()) return { top: [], topPercent: "0.00" };

  const totalDec = new Decimal(total.toString());
  const sorted = [...nonZero].sort((a, b) =>
    new Decimal(b.value.toString()).comparedTo(new Decimal(a.value.toString())),
  );
  const top = sorted.slice(0, topN).map((p) => ({
    label: p.label,
    value: p.value,
    percent: new Decimal(p.value.toString())
      .dividedBy(totalDec)
      .times(100)
      .toDecimalPlaces(2)
      .toFixed(2),
  }));

  const topSum = Money.sum(
    top.map((r) => r.value),
    currency,
  );
  const topPercent = new Decimal(topSum.toString())
    .dividedBy(totalDec)
    .times(100)
    .toDecimalPlaces(2)
    .toFixed(2);

  return { top, topPercent };
}
