import { backfillCategories } from "@/lib/categorization/backfill.ts";
import type { Job } from "bullmq";

/**
 * One-shot worker job (P8-04): backfill the structured `categories` model from
 * the legacy free-text `category` columns.
 *
 * Idempotent — safe to re-run. Intended to be invoked once post-deploy via
 * `src/worker/run-once.ts`, not on a schedule. Logs the resulting counts so the
 * operator can verify nothing was missed.
 */
export async function backfillCategoriesProcessor(_job: Job): Promise<void> {
  const result = await backfillCategories();
  console.info(
    `[backfill-categories] groupsCreated=${result.groupsCreated} ` +
      `categoriesCreated=${result.categoriesCreated} ` +
      `txnsLinked=${result.txnsLinked} rulesLinked=${result.rulesLinked}`,
  );
}
