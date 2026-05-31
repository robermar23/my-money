"use server";

import { db } from "@/db/client.ts";
import { importBatches } from "@/db/schema/index.ts";
import { getAccount } from "@/lib/accounts/queries.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { parseCsv } from "@/lib/importers/csv/parse.ts";
import type { CsvColumnMapping } from "@/lib/importers/csv/types.ts";
import { csvToNormalized, qfxToNormalized } from "@/lib/importers/normalize.ts";
import { persistImportBatch } from "@/lib/importers/persist.ts";
import { parseQfx } from "@/lib/importers/qfx/parse.ts";
import {
  type DetectedSource,
  checkSize,
  detectSource,
  sanitizeFilename,
} from "@/lib/importers/upload-security.ts";
import { processImportQueue } from "@/lib/queue/queues.ts";
import { toAccountId } from "@/lib/types/ids.ts";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

export interface ImportUploadResult {
  error?: string;
  ok?: boolean;
}

export interface ImportConfirmResult {
  error?: string;
  ok?: boolean;
  insertedCount?: number;
  duplicateCount?: number;
}

/** Threshold below which we parse inline; above which we hand off to BullMQ. */
const INLINE_PARSE_LIMIT_BYTES = 1 * 1024 * 1024;

const CSV_MAPPING_SCHEMA = z.object({
  date: z.string().min(1),
  amount: z.string().optional(),
  debit: z.string().optional(),
  credit: z.string().optional(),
  name: z.string().min(1),
  memo: z.string().optional(),
  dateFormat: z.enum(["MM/DD/YYYY", "YYYY-MM-DD", "M/D/YYYY"]).optional(),
  hasHeader: z.boolean().optional(),
});

/**
 * Server action: upload an import file.
 *
 * - Sanitizes the filename and validates size + content.
 * - Inserts an import_batches row.
 * - For small files: parses inline and moves status to 'previewed'.
 * - For large files: leaves status='pending' and enqueues a worker job.
 *
 * Redirects to either the preview page or the polling page.
 */
export async function uploadImportAction(
  accountIdRaw: string,
  _prev: ImportUploadResult,
  formData: FormData,
): Promise<ImportUploadResult> {
  await requireUser();
  const accountId = toAccountId(accountIdRaw);
  const account = await getAccount(accountId);
  if (!account) return { error: "Account not found" };
  if (account.type !== "depository" && account.type !== "credit_card") {
    return { error: "Imports are only supported for cash and credit-card accounts" };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Please choose a file" };
  }

  const sizeErr = checkSize(file.size);
  if (sizeErr) return { error: sizeErr };

  const buf = Buffer.from(await file.arrayBuffer());
  const filename = sanitizeFilename(file.name);
  const detected = detectSource(filename, buf);
  if (detected === "unknown") {
    return {
      error: "File does not look like an OFX/QFX or CSV export (magic-byte check failed)",
    };
  }

  // CSV mapping (only relevant for CSV uploads).
  let csvMapping: CsvColumnMapping | undefined;
  if (detected === "csv") {
    const raw = formData.get("csvMapping");
    if (typeof raw !== "string" || raw.length === 0) {
      return {
        error: "CSV uploads require a column mapping (date/amount/name)",
      };
    }
    let parsedMapping: unknown;
    try {
      parsedMapping = JSON.parse(raw);
    } catch {
      return { error: "csvMapping must be valid JSON" };
    }
    const validated = CSV_MAPPING_SCHEMA.safeParse(parsedMapping);
    if (!validated.success) {
      return { error: `Invalid CSV mapping: ${validated.error.issues[0]?.message ?? "unknown"}` };
    }
    csvMapping = validated.data as CsvColumnMapping;
  }

  const [batch] = await db
    .insert(importBatches)
    .values({
      accountId,
      source: detected as DetectedSource as "qfx" | "csv",
      filename,
      status: "pending",
      rawFile: buf,
    })
    .returning({ id: importBatches.id });
  if (!batch) return { error: "Failed to create import batch" };

  // Parse + persist inside a try block so we can capture errors; redirect
  // happens AFTER the try because Next.js implements `redirect()` by throwing
  // a sentinel error that we'd otherwise swallow and mis-report as a parse
  // failure ("Parse failed: NEXT_REDIRECT").
  if (buf.byteLength <= INLINE_PARSE_LIMIT_BYTES) {
    try {
      if (detected === "qfx") {
        const normalized = qfxToNormalized(parseQfx(buf));
        await db
          .update(importBatches)
          .set({
            status: "previewed",
            parsedPayload: normalized,
            parserMetadata: normalized.metadata,
            statementStart: normalized.statementStart,
            statementEnd: normalized.statementEnd,
            statementEndingBalance: normalized.statementEndingBalance,
          })
          .where(eq(importBatches.id, batch.id));
      } else if (csvMapping) {
        const normalized = csvToNormalized(parseCsv(buf, csvMapping));
        await db
          .update(importBatches)
          .set({
            status: "previewed",
            parsedPayload: normalized,
            parserMetadata: normalized.metadata,
          })
          .where(eq(importBatches.id, batch.id));
      }
    } catch (err) {
      // Capture parse error to the row, then surface to the user.
      await db
        .update(importBatches)
        .set({ status: "failed", error: (err as Error).message })
        .where(eq(importBatches.id, batch.id));
      return { error: `Parse failed: ${(err as Error).message}` };
    }
    revalidatePath(`/accounts/${accountId}`);
    redirect(`/accounts/${accountId}/import/${batch.id}/preview`);
  }

  await processImportQueue.add(
    "process-import",
    { batchId: batch.id, csvMapping },
    { jobId: `import-${batch.id}` },
  );
  revalidatePath(`/accounts/${accountId}`);
  redirect(`/accounts/${accountId}/import/${batch.id}`);
}

/**
 * Server action: confirm a previewed batch.
 */
export async function confirmImportAction(
  accountIdRaw: string,
  batchIdRaw: string,
): Promise<ImportConfirmResult> {
  await requireUser();
  const accountId = toAccountId(accountIdRaw);
  const account = await getAccount(accountId);
  if (!account) return { error: "Account not found" };

  // Basic UUID check on batchId (toAccountId reuses the same regex; we cheat).
  if (!/^[0-9a-f-]{36}$/i.test(batchIdRaw)) {
    return { error: "Invalid batch id" };
  }

  // Same redirect-outside-try pattern as uploadImportAction — see the comment
  // there for why this is required.
  let insertedCount: number;
  try {
    const result = await persistImportBatch(batchIdRaw);
    insertedCount = result.insertedCount;
  } catch (err) {
    return { error: (err as Error).message };
  }
  revalidatePath(`/accounts/${accountId}`);
  revalidatePath("/");
  redirect(`/accounts/${accountId}?imported=${insertedCount}`);
}

/**
 * Server action: delete a failed or pending batch.
 */
export async function deleteImportBatchAction(
  accountIdRaw: string,
  batchIdRaw: string,
): Promise<{ error?: string }> {
  await requireUser();
  if (!/^[0-9a-f-]{36}$/i.test(batchIdRaw)) return { error: "Invalid batch id" };
  const accountId = toAccountId(accountIdRaw);
  await db.delete(importBatches).where(eq(importBatches.id, batchIdRaw));
  revalidatePath(`/accounts/${accountId}`);
  redirect(`/accounts/${accountId}`);
}
