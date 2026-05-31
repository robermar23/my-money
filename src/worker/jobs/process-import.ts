import { db } from "@/db/client.ts";
import { importBatches } from "@/db/schema/index.ts";
import { parseCsv } from "@/lib/importers/csv/parse.ts";
import type { CsvColumnMapping } from "@/lib/importers/csv/types.ts";
import { csvToNormalized, qfxToNormalized } from "@/lib/importers/normalize.ts";
import { parseQfx } from "@/lib/importers/qfx/parse.ts";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";

export interface ProcessImportJobData {
  readonly batchId: string;
  /** Required for CSV; ignored for QFX. */
  readonly csvMapping?: CsvColumnMapping;
}

/**
 * Worker job: parse a `pending` import_batches row and move it to `previewed`.
 *
 * Idempotent on batchId:
 *   - status='confirmed' → no-op (return).
 *   - status='previewed' → no-op.
 *   - status='failed'    → re-attempt (the queue retry mechanic decides).
 *   - status='pending'   → parse, set parsedPayload + parserMetadata + statement
 *                          fields, status='previewed'. On parse error: status='failed'.
 *
 * Per CLAUDE.md §Background Jobs: idempotent; retries via queue defaults.
 */
export async function processImportProcessor(job: Job<ProcessImportJobData>): Promise<void> {
  const { batchId, csvMapping } = job.data;
  if (!batchId) throw new Error("processImportProcessor: missing batchId");

  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!batch) throw new Error(`Import batch ${batchId} not found`);
  if (batch.status === "previewed" || batch.status === "confirmed") return;

  if (!batch.rawFile) {
    await db
      .update(importBatches)
      .set({ status: "failed", error: "raw_file is empty — cannot parse" })
      .where(eq(importBatches.id, batchId));
    return;
  }

  try {
    if (batch.source === "qfx") {
      const parsed = parseQfx(batch.rawFile);
      const normalized = qfxToNormalized(parsed);
      await db
        .update(importBatches)
        .set({
          status: "previewed",
          parsedPayload: normalized,
          parserMetadata: normalized.metadata,
          statementStart: normalized.statementStart,
          statementEnd: normalized.statementEnd,
          statementEndingBalance: normalized.statementEndingBalance,
          error: null,
        })
        .where(eq(importBatches.id, batchId));
    } else if (batch.source === "csv") {
      if (!csvMapping) {
        throw new Error("CSV import requires csvMapping in job data");
      }
      const parsed = parseCsv(batch.rawFile, csvMapping);
      const normalized = csvToNormalized(parsed);
      await db
        .update(importBatches)
        .set({
          status: "previewed",
          parsedPayload: normalized,
          parserMetadata: normalized.metadata,
          statementStart: normalized.statementStart,
          statementEnd: normalized.statementEnd,
          statementEndingBalance: normalized.statementEndingBalance,
          error: null,
        })
        .where(eq(importBatches.id, batchId));
    } else {
      throw new Error(`Unknown import source '${batch.source}'`);
    }
  } catch (err) {
    await db
      .update(importBatches)
      .set({ status: "failed", error: (err as Error).message })
      .where(eq(importBatches.id, batchId));
    throw err; // let BullMQ surface as a failure (retry policy will re-run)
  }
}
