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
 * The jobId is `Date.now`-suffixed so repeated clicks each enqueue a job; the
 * worker's idempotent `(symbol, date)` price upsert means a small backlog drains
 * harmlessly.
 *
 * @returns An empty object on success, or `{ error }` if enqueue failed.
 */
export async function refreshPricesAction(): Promise<RefreshPricesResult> {
  await requireUser();
  await fetchPricesDailyQueue.add(
    QUEUE_NAMES.FETCH_PRICES_DAILY,
    {},
    { jobId: `fetch-prices-manual-${Date.now()}` },
  );
  revalidatePath("/investments");
  return {};
}
