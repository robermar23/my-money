import { recategorizeAll } from "@/lib/importers/persist.ts";
import type { Job } from "bullmq";

/**
 * Worker job: re-evaluate category rules over all non-overridden transactions.
 *
 * Idempotent: returns the number of rows updated; safe to re-run.
 */
export async function recategorizeAllProcessor(_job: Job): Promise<void> {
  await recategorizeAll();
}
