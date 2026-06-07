import * as nodeFs from "node:fs/promises";
import { join } from "node:path/posix";
import { db } from "@/db/client.ts";
import { accountSnapshots, accounts, prices, transactions } from "@/db/schema/index.ts";
import { type BeancountInput, renderBeancount } from "@/lib/export/beancount.ts";
import type { Job } from "bullmq";

/**
 * Phase 6 (P6-09) — nightly beancount export (ADR-016).
 *
 * Reads the whole DB, renders a deterministic plain-text mirror, and writes it
 * atomically (`*.tmp` → rename) to `BEANCOUNT_DIR/money.beancount` so a reader
 * (or `rsync`) never sees a half-written file.
 *
 * Opt-in: with `BEANCOUNT_DIR` unset the job skips. (No secret gates it — it's a
 * plaintext mirror of data already in Postgres; the only requirement is a target
 * directory, which the prod compose mounts.)
 *
 * Deps injectable for tests (fs/env/data-loader/clock), mirroring the backup job.
 */

const FINAL_NAME = "money.beancount";
const TMP_NAME = "money.beancount.tmp";

type BeancountData = Omit<BeancountInput, "generatedAt">;

/** Minimal fs surface the job needs — narrow so test fakes type cleanly. */
export interface BeancountFs {
  writeFile(path: string, content: string, encoding: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface ExportBeancountDeps {
  readonly fs?: BeancountFs;
  readonly env?: Record<string, string | undefined>;
  /** Loads the rows to export; defaults to reading the live DB. */
  readonly load?: () => Promise<BeancountData>;
  readonly now?: () => Date;
}

export interface ExportBeancountResult {
  readonly skipped?: boolean;
  readonly path?: string;
  readonly bytes?: number;
}

/** Default loader: pull every account/snapshot/price/transaction from Postgres. */
async function loadFromDb(): Promise<BeancountData> {
  const [accountRows, snapshotRows, priceRows, txnRows] = await Promise.all([
    db.select().from(accounts),
    db.select().from(accountSnapshots),
    db.select().from(prices),
    db.select().from(transactions),
  ]);
  return {
    accounts: accountRows,
    snapshots: snapshotRows,
    prices: priceRows,
    transactions: txnRows,
  };
}

export async function exportBeancountDailyProcessor(
  _job: Job,
  deps: ExportBeancountDeps = {},
): Promise<ExportBeancountResult> {
  const fs: BeancountFs = deps.fs ?? nodeFs;
  const env = deps.env ?? process.env;
  const load = deps.load ?? loadFromDb;
  const now = (deps.now ?? (() => new Date()))();

  const dir = env.BEANCOUNT_DIR?.trim();
  if (!dir) {
    console.error("[export-beancount-daily] disabled: BEANCOUNT_DIR not set; skipping");
    return { skipped: true };
  }

  const data = await load();
  const content = renderBeancount({ ...data, generatedAt: now });

  // Atomic write: a reader/rsync never observes a partial file.
  const tmpPath = join(dir, TMP_NAME);
  const finalPath = join(dir, FINAL_NAME);
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, finalPath);

  console.error(`[export-beancount-daily] wrote ${FINAL_NAME} (${content.length} bytes)`);
  return { path: finalPath, bytes: content.length };
}
