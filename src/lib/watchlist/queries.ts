import "server-only";

import { db } from "@/db/client.ts";
import { priceTargets, watchlistItems } from "@/db/schema/index.ts";
import type { PriceTarget, WatchlistItem } from "@/db/schema/index.ts";
import { securityPriceHistory } from "@/lib/investments/queries.ts";
import { latestCloseOnOrBefore } from "@/lib/prices/store.ts";
import { trigramIlikeAny } from "@/lib/search/predicates.ts";
import { sanitizeSearchTerm } from "@/lib/search/term.ts";
import { type PaperValuation, paperValuation } from "@/lib/watchlist/valuation.ts";
import { asc, count, desc, eq } from "drizzle-orm";

/**
 * Read-side for the `/watchlist` UI (Phase 11, P11-14, ADR-025).
 *
 * Watchlist value/history is computed ON READ off the shared `prices` series —
 * there is no snapshot table (a watch row isn't net worth). Money stays in
 * `Money`/string here; `Number()` happens only at the chart/format display edge.
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** ISO date `months` before today, UTC — the detail chart window. */
function isoMonthsAgo(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

export interface WatchlistRow {
  readonly id: string;
  readonly symbol: string;
  readonly label: string | null;
  readonly assetClass: string;
  readonly currency: string;
  /** Latest close on or before today, or null when never priced yet. */
  readonly latestClose: string | null;
  /** Paper-position valuation (value/costBasis/gainLoss), nulls when watch-only. */
  readonly valuation: PaperValuation;
  /** True when the item carries a pretend position (has a basis to value). */
  readonly hasPretend: boolean;
  /** Count of still-armed (active) price targets. */
  readonly activeTargetCount: number;
}

/**
 * Every watched symbol with its latest close, paper valuation, and active-target
 * count — display-ready rows for the list page. Missing-price items carry null
 * valuation (the page renders "—"); nothing throws.
 *
 * With no `q` the behavior is unchanged (all watched symbols, sorted). A provided
 * `q` is sanitized and matched against `symbol`/`label`/`notes` via the trigram
 * `ILIKE` predicate (Phase 12, P12-17); a too-short term is ignored (treated as
 * no filter), matching the rest of the search surface.
 *
 * @param opts.q - Optional free-text term to filter by.
 * @returns Watchlist rows sorted by symbol.
 */
export async function listWatchlist(opts?: { q?: string }): Promise<WatchlistRow[]> {
  const term = sanitizeSearchTerm(opts?.q);
  const where = term
    ? trigramIlikeAny([watchlistItems.symbol, watchlistItems.label, watchlistItems.notes], term)
    : undefined;
  const items = await db
    .select()
    .from(watchlistItems)
    .where(where)
    .orderBy(asc(watchlistItems.symbol));

  // One grouped pass for active-target counts, keyed by watchlist item.
  const counts = await db
    .select({ itemId: priceTargets.watchlistItemId, n: count() })
    .from(priceTargets)
    .where(eq(priceTargets.active, true))
    .groupBy(priceTargets.watchlistItemId);
  const activeByItem = new Map<string, number>(counts.map((c) => [c.itemId, c.n]));

  const today = new Date().toISOString().slice(0, 10);

  return Promise.all(
    items.map(async (item): Promise<WatchlistRow> => {
      const latestClose = await latestCloseOnOrBefore(item.symbol, today);
      const valuation = paperValuation(
        {
          pretendQuantity: item.pretendQuantity,
          pretendUnitCost: item.pretendUnitCost,
          currency: item.currency,
        },
        latestClose,
      );
      return {
        id: item.id,
        symbol: item.symbol,
        label: item.label,
        assetClass: item.assetClass,
        currency: item.currency,
        latestClose,
        valuation,
        hasPretend: item.pretendQuantity !== null,
        activeTargetCount: activeByItem.get(item.id) ?? 0,
      };
    }),
  );
}

export interface WatchlistDetail {
  readonly item: WatchlistItem;
  readonly latestClose: string | null;
  readonly valuation: PaperValuation;
  readonly targets: readonly PriceTarget[];
  /** Daily closes (date + value string) for the chart, over the window. */
  readonly priceHistory: readonly { date: string; value: string }[];
}

/**
 * One watch item with its targets, latest close, paper valuation, and price
 * history for the detail page. Returns null for a missing/invalid id (the page
 * maps that to `notFound()`).
 *
 * @param id - The watchlist item UUID.
 * @returns The detail bundle, or null when the id is malformed or absent.
 */
export async function watchlistItemDetail(id: string): Promise<WatchlistDetail | null> {
  if (!UUID_RE.test(id)) return null;

  const [item] = await db.select().from(watchlistItems).where(eq(watchlistItems.id, id)).limit(1);
  if (!item) return null;

  const today = new Date().toISOString().slice(0, 10);
  // History window: from the pretend purchase date (so a paper position's chart
  // reaches back to its hypothetical buy), else the last 24 months.
  const from = item.pretendPurchasedAt ?? isoMonthsAgo(24);

  const [latestClose, targets, priceHistory] = await Promise.all([
    latestCloseOnOrBefore(item.symbol, today),
    db
      .select()
      .from(priceTargets)
      .where(eq(priceTargets.watchlistItemId, id))
      .orderBy(desc(priceTargets.active), desc(priceTargets.createdAt)),
    securityPriceHistory(item.symbol, { from, to: today }),
  ]);

  const valuation = paperValuation(
    {
      pretendQuantity: item.pretendQuantity,
      pretendUnitCost: item.pretendUnitCost,
      currency: item.currency,
    },
    latestClose,
  );

  return { item, latestClose, valuation, targets, priceHistory };
}

/** Whether a price-history series is too short to chart (drives the "limited" note). */
export function isLimitedHistory(points: readonly unknown[]): boolean {
  return points.length < 2;
}
