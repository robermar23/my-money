import { db } from "@/db/client.ts";
import { alerts, priceTargets, prices, watchlistItems } from "@/db/schema/index.ts";
import { notifyNewAlerts } from "@/lib/alerts/notify.ts";
import { type PriceTargetInput, priceTargetAlerts } from "@/lib/alerts/rules.ts";
import { paperValuation } from "@/lib/watchlist/valuation.ts";
import type { Job } from "bullmq";
import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";

/**
 * Phase 11 (P11-11, ADR-026) — one-shot watchlist price-target evaluator.
 *
 * Chained off `fetch-prices-daily` (P11-12) so it always reads the freshest
 * close with no race. For each ACTIVE target it loads the symbol's latest close,
 * runs the pure {@link priceTargetAlerts} rule, persists any fired alert
 * (idempotent on `dedup_hash`), flips the fired target inactive + stamps
 * `triggered_at`/`triggered_price`, and rings the Phase-6 content-free
 * notification doorbell for whatever is now open + un-notified.
 *
 * One-shot: a fired target goes `active = false`, so the next run won't reload it
 * (and the dedup hash would no-op anyway). The user re-arms by re-activating it.
 * `price_target` is deliberately NOT a `RULE_ALERT_TYPES` member — it is never
 * resolve-swept (same exemption as `backup_failure`).
 *
 * Deps injectable (load/now/notify) per the `detect-anomalies-daily` pattern so
 * the rule→persist→stamp→notify wiring is testable without seeding every table.
 */
export interface EvaluatePriceTargetsResult {
  /** New `alerts` rows inserted (post-dedup). */
  readonly created: number;
  /** Targets flipped inactive this run. */
  readonly triggered: number;
  /** Alerts the content-free email covered (0 when SMTP disabled). */
  readonly notified: number;
}

export interface EvaluatePriceTargetsDeps {
  readonly load?: (now: Date) => Promise<readonly PriceTargetInput[]>;
  readonly now?: () => Date;
  readonly notify?: (count: number, date: string) => Promise<{ sent: boolean }>;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Default loader: active targets joined to their watchlist item, each paired
 * with the symbol's latest close on or before today. Computes the optional
 * pretend P&L (for the authenticated UI's `detail`) when the item carries a
 * paper position.
 */
async function loadActiveTargets(now: Date): Promise<PriceTargetInput[]> {
  const today = isoDate(now);
  const rows = await db
    .select({
      targetId: priceTargets.id,
      watchlistItemId: watchlistItems.id,
      symbol: watchlistItems.symbol,
      direction: priceTargets.direction,
      threshold: priceTargets.threshold,
      currency: watchlistItems.currency,
      pretendQuantity: watchlistItems.pretendQuantity,
      pretendUnitCost: watchlistItems.pretendUnitCost,
    })
    .from(priceTargets)
    .innerJoin(watchlistItems, eq(priceTargets.watchlistItemId, watchlistItems.id))
    .where(eq(priceTargets.active, true));

  const out: PriceTargetInput[] = [];
  for (const r of rows) {
    const [p] = await db
      .select({ close: prices.close, date: prices.date })
      .from(prices)
      .where(and(eq(prices.symbol, r.symbol), lte(prices.date, today)))
      .orderBy(desc(prices.date))
      .limit(1);
    const latestClose = p?.close ?? null;

    const pv = paperValuation(
      {
        pretendQuantity: r.pretendQuantity,
        pretendUnitCost: r.pretendUnitCost,
        currency: r.currency,
      },
      latestClose,
    );
    const pretendPnl = pv.costBasis
      ? {
          value: pv.value?.toString() ?? null,
          costBasis: pv.costBasis.toString(),
          gainAbsolute: pv.gainLoss.absolute?.toString() ?? null,
          gainPercent: pv.gainLoss.percent,
        }
      : null;

    out.push({
      targetId: r.targetId,
      watchlistItemId: r.watchlistItemId,
      symbol: r.symbol,
      direction: r.direction === "below" ? "below" : "above",
      threshold: r.threshold,
      latestClose,
      latestDate: p?.date ?? null,
      currency: r.currency,
      pretendPnl,
    });
  }
  return out;
}

export async function evaluatePriceTargetsProcessor(
  _job: Job,
  deps: EvaluatePriceTargetsDeps = {},
): Promise<EvaluatePriceTargetsResult> {
  const now = (deps.now ?? (() => new Date()))();
  const inputs = await (deps.load ?? loadActiveTargets)(now);
  const detected = priceTargetAlerts(inputs);

  // Persist — idempotent on dedup_hash, so a re-run inserts nothing new.
  let created = 0;
  if (detected.length > 0) {
    const inserted = await db
      .insert(alerts)
      .values(
        detected.map((d) => ({
          type: d.type,
          severity: d.severity,
          dedupHash: d.dedupHash,
          title: d.title,
          detail: d.detail,
        })),
      )
      .onConflictDoNothing({ target: alerts.dedupHash })
      .returning({ id: alerts.id });
    created = inserted.length;
  }

  // Flip every fired target inactive + stamp the close that satisfied it. Guarded
  // on `active = true` so a re-run (target already inactive) is a clean no-op.
  let triggered = 0;
  for (const d of detected) {
    const targetId = d.detail.targetId as string;
    const triggeredPrice = d.detail.price as string;
    const res = await db
      .update(priceTargets)
      .set({ active: false, triggeredAt: now, triggeredPrice, updatedAt: now })
      .where(and(eq(priceTargets.id, targetId), eq(priceTargets.active, true)))
      .returning({ id: priceTargets.id });
    triggered += res.length;
  }

  // Ring the content-free doorbell for everything open + un-notified (P6-14).
  let notified = 0;
  const unnotified = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(isNull(alerts.notifiedAt), isNull(alerts.resolvedAt)));
  if (unnotified.length > 0) {
    const notifyFn = deps.notify ?? ((c: number, d: string) => notifyNewAlerts(c, d));
    const res = await notifyFn(unnotified.length, isoDate(now));
    if (res.sent) {
      await db
        .update(alerts)
        .set({ notifiedAt: now })
        .where(
          inArray(
            alerts.id,
            unnotified.map((r) => r.id),
          ),
        );
      notified = unnotified.length;
    }
  }

  return { created, triggered, notified };
}
