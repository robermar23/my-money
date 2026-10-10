import { db } from "@/db/client.ts";
import { plaidItems } from "@/db/schema/index.ts";
import { syncInvestmentsItemQueue, syncPlaidItemQueue } from "@/lib/queue/queues.ts";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";

/**
 * P4-27 — Daily safety-net cron.
 *
 * Webhooks are the primary sync trigger; this cron catches the ones Plaid
 * dropped, our tunnel missed, or we accidentally dropped on the floor. Runs at
 * 03:00 UTC (one hour after the snapshot job) — by then the daily price +
 * snapshot work is finished and the worker is otherwise idle.
 *
 * Strategy:
 *   - SELECT every plaid_items row with `status='active'`. Items in
 *     login_required / pending_disconnect / revoked / removed are skipped —
 *     the worker would just re-fail or no-op.
 *   - For each Item, enqueue a `sync-plaid-item` job with `trigger='cron'`.
 *   - jobId is pinned to `sync-plaid-item-cron-<today>-<itemPk>` so a same-day
 *     re-fire (e.g., the cron firing twice across a DST hop) collapses to one
 *     job. The worker itself is already idempotent at the cursor level (P4-18),
 *     but pinning the jobId saves a round trip.
 *
 * Returns the number of jobs enqueued so a future ops dashboard can chart it.
 */
export async function enqueuePlaidSyncsDailyProcessor(
  _job: Job,
): Promise<{ enqueued: number; skipped: number }> {
  const items = await db
    .select({ id: plaidItems.id, productsConsented: plaidItems.productsConsented })
    .from(plaidItems)
    .where(eq(plaidItems.status, "active"));

  const today = new Date().toISOString().slice(0, 10);
  let enqueued = 0;
  for (const item of items) {
    // P5-17 — fan out the sync that matches the Item's products. (Items are
    // single-product per ADR-008/011, but this handles both defensively.)
    if (item.productsConsented.includes("investments")) {
      await syncInvestmentsItemQueue.add(
        "sync-investments-item",
        { plaidItemPk: item.id, trigger: "cron" },
        { jobId: `sync-investments-item-cron-${today}-${item.id}` },
      );
      enqueued++;
    }
    if (item.productsConsented.includes("transactions")) {
      await syncPlaidItemQueue.add(
        "sync-plaid-item",
        { plaidItemPk: item.id, trigger: "cron" },
        { jobId: `sync-plaid-item-cron-${today}-${item.id}` },
      );
      enqueued++;
    }
  }
  return { enqueued, skipped: 0 };
}
