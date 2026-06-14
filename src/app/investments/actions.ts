"use server";

import { requireUser } from "@/lib/auth/require-user.ts";
import { QUEUE_NAMES, fetchPricesDailyQueue } from "@/lib/queue/queues.ts";
import { revalidatePath } from "next/cache";

export interface RefreshPricesResult {
  error?: string;
}

/**
 * Manually enqueue the daily price fetch (Yahoo equities/metals + CoinGecko
 * crypto) on demand, instead of waiting for the 01:30 cron.
 *
 * Handy right after connecting an investment account: holdings exist but their
 * prices haven't been fetched yet, so positions read $0 until the first fetch.
 *
 * The jobId is bucketed per-minute so a flurry of clicks collapses to one job
 * (BullMQ dedupes by jobId) — repeatedly hammering the button can't self-inflict
 * an upstream 429. A fresh minute allows a new run.
 *
 * @returns An empty object on success, or `{ error }` if enqueue failed.
 */
export async function refreshPricesAction(): Promise<RefreshPricesResult> {
  await requireUser();
  const minuteBucket = Math.floor(Date.now() / 60_000);
  await fetchPricesDailyQueue.add(
    QUEUE_NAMES.FETCH_PRICES_DAILY,
    {},
    { jobId: `fetch-prices-manual-${minuteBucket}` },
  );
  revalidatePath("/investments");
  return {};
}
