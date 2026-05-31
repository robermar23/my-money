import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, importBatches } from "@/db/schema/index.ts";
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type ProcessImportJobData, processImportProcessor } from "./process-import.ts";

function fixture(rel: string): Buffer {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
}

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE transactions, import_batches, accounts CASCADE`);
}

async function seedAccount(): Promise<string> {
  const [acc] = await db
    .insert(accounts)
    .values({ name: "M&T", institution: "M&T", type: "depository", currency: "USD" })
    .returning({ id: accounts.id });
  if (!acc) throw new Error("seed");
  return acc.id;
}

function fakeJob(data: ProcessImportJobData): Job<ProcessImportJobData> {
  return { id: "test", name: "process-import", data } as unknown as Job<ProcessImportJobData>;
}

describe("processImportProcessor", () => {
  beforeEach(async () => {
    await reset();
  });

  afterAll(async () => {
    await reset();
  });

  it("parses a pending QFX batch and moves it to previewed", async () => {
    const accountId = await seedAccount();
    const raw = fixture("../../lib/importers/qfx/__fixtures__/mt-checking.qfx");
    const [batch] = await db
      .insert(importBatches)
      .values({
        accountId,
        source: "qfx",
        filename: "mt-checking.qfx",
        status: "pending",
        rawFile: raw,
      })
      .returning({ id: importBatches.id });
    if (!batch) throw new Error("seed");

    await processImportProcessor(fakeJob({ batchId: batch.id }));

    const [after] = await db.select().from(importBatches).where(eq(importBatches.id, batch.id));
    expect(after?.status).toBe("previewed");
    expect(after?.statementEndingBalance).toBe("1639.40");
    expect(after?.parsedPayload).not.toBeNull();
  });

  it("is idempotent on previewed batches", async () => {
    const accountId = await seedAccount();
    const [batch] = await db
      .insert(importBatches)
      .values({
        accountId,
        source: "qfx",
        filename: "x.qfx",
        status: "previewed",
        rawFile: fixture("../../lib/importers/qfx/__fixtures__/mt-checking.qfx"),
        parsedPayload: { source: "qfx", transactions: [] },
      })
      .returning({ id: importBatches.id });
    if (!batch) throw new Error("seed");

    await processImportProcessor(fakeJob({ batchId: batch.id }));

    const [after] = await db.select().from(importBatches).where(eq(importBatches.id, batch.id));
    expect(after?.status).toBe("previewed");
  });

  it("marks the batch failed on parser error", async () => {
    const accountId = await seedAccount();
    const [batch] = await db
      .insert(importBatches)
      .values({
        accountId,
        source: "qfx",
        filename: "broken.qfx",
        status: "pending",
        rawFile: Buffer.from("totally not an OFX file"),
      })
      .returning({ id: importBatches.id });
    if (!batch) throw new Error("seed");

    await expect(processImportProcessor(fakeJob({ batchId: batch.id }))).rejects.toThrow();

    const [after] = await db.select().from(importBatches).where(eq(importBatches.id, batch.id));
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/OFX|root|recognizable/i);
  });
});
