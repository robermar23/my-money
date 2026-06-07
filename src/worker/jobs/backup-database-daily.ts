import { spawn as nodeSpawn } from "node:child_process";
import * as nodeFs from "node:fs/promises";
// posix join: the backup job runs in the Linux worker container, so paths must
// use `/` regardless of the host the tests happen to run on (Windows dev box).
import { join } from "node:path/posix";
import { clearBackupFailure, recordBackupFailure } from "@/lib/alerts/backup-alert.ts";
import type { Job } from "bullmq";

/**
 * Phase 6 (P6-04) — nightly encrypted database backup (ADR-014).
 *
 * Streams `pg_dump --format=custom` directly into `age` and writes only the
 * `age`-encrypted ciphertext to `BACKUP_DIR`. The plaintext dump never lands on
 * disk — it lives only in the pipe between the two child processes.
 *
 * Security (backend-security-coder):
 *   - Both children are launched with `spawn(cmd, argsArray)` — never a shell
 *     string — so `DATABASE_URL` (which carries the DB password) and the `age`
 *     recipient are discrete argv entries and cannot be interpreted by a shell.
 *     There is no `shell: true`; injection is structurally impossible.
 *   - `DATABASE_URL` is never logged. We log only the output filename + counts.
 *   - `age` is given a RECIPIENT (public key) only. The matching identity
 *     (private key) is never on this box, so a server compromise cannot decrypt
 *     past backups (ADR-014).
 *
 * Encryption is one-way here: the column-level AES-GCM on Plaid tokens (ADR-009)
 * is re-wrapped inside the age dump → double-encrypted at rest, useless without
 * BOTH keys.
 *
 * Idempotent enough for a daily cron: each run produces a fresh timestamped
 * file; re-running just writes another. Retention prunes files older than
 * `BACKUP_RETAIN_DAYS` after a successful write.
 *
 * Deps are injectable so tests can drive spawn/fs/env/clock without real
 * `pg_dump`/`age` binaries (mirrors the `fetchPricesDailyProcessor` router arg).
 */

const DEFAULT_BACKUP_DIR = "/backups";
const DEFAULT_RETAIN_DAYS = 14;
const BACKUP_FILE_RE = /^money-(\d{8}T\d{6}Z)\.dump\.age$/;

export interface BackupResult {
  /** True when backup is disabled (no recipient configured) — not an error. */
  readonly skipped?: boolean;
  /** Absolute path of the file written on success. */
  readonly outPath?: string;
  /** How many stale backups were pruned after the write. */
  readonly pruned?: number;
}

/** Minimal fs surface the job needs — narrow so test fakes type cleanly. */
export interface BackupFs {
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
}

export interface BackupDeps {
  readonly spawn?: typeof nodeSpawn;
  readonly fs?: BackupFs;
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => Date;
  /** Raise a `backup_failure` alert (P6-16). DB-backed default; no-op-able in tests. */
  readonly onFailureAlert?: (now: Date, error: string) => Promise<void>;
  /** Clear open `backup_failure` alerts on success. DB-backed default. */
  readonly onSuccessAlert?: (now: Date) => Promise<void>;
}

/** Filesystem-safe, sortable backup filename: `money-YYYYMMDDTHHMMSSZ.dump.age`. */
export function backupFilename(date: Date): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `money-${stamp}.dump.age`;
}

/** Inverse of {@link backupFilename}; returns ms-epoch, or null if not a backup file. */
export function parseBackupTimestamp(filename: string): number | null {
  const m = BACKUP_FILE_RE.exec(filename);
  if (!m?.[1]) return null;
  const s = m[1]; // YYYYMMDDTHHMMSSZ
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(
    11,
    13,
  )}:${s.slice(13, 15)}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** `pg_dump` argv. `databaseUrl` is a discrete arg — never shell-interpolated. */
export function pgDumpArgs(databaseUrl: string): readonly string[] {
  return ["--format=custom", "--no-password", "--dbname", databaseUrl];
}

/** `age` argv. Recipient (public key) + output path are discrete args. */
export function ageArgs(recipient: string, outPath: string): readonly string[] {
  return ["--recipient", recipient, "--output", outPath];
}

/**
 * Pure retention policy: given the current dir listing, the clock, and the
 * retain window, return the backup filenames that should be deleted. Files that
 * don't match the backup pattern are left untouched (we never delete unknown
 * files).
 */
export function filesToPrune(
  filenames: readonly string[],
  now: Date,
  retainDays: number,
): string[] {
  const cutoff = now.getTime() - retainDays * 24 * 60 * 60 * 1000;
  const stale: string[] = [];
  for (const name of filenames) {
    const ts = parseBackupTimestamp(name);
    if (ts !== null && ts < cutoff) stale.push(name);
  }
  return stale;
}

function parseRetainDays(raw: string | undefined): number {
  if (!raw) return DEFAULT_RETAIN_DAYS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETAIN_DAYS;
}

/** Resolve when a child closes; resolves with its exit code (or rejects on spawn error). */
function onClose(child: ReturnType<typeof nodeSpawn>, label: string): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", (err) => reject(new Error(`${label} failed to start: ${err.message}`)));
    child.on("close", (code) => resolve(code ?? 0));
  });
}

function collectStderr(child: ReturnType<typeof nodeSpawn>): { text: () => string } {
  let buf = "";
  child.stderr?.on("data", (chunk) => {
    if (buf.length < 4096) buf += String(chunk);
  });
  return { text: () => buf.trim() };
}

export async function backupDatabaseDailyProcessor(
  _job: Job,
  deps: BackupDeps = {},
): Promise<BackupResult> {
  const spawn = deps.spawn ?? nodeSpawn;
  const fs: BackupFs = deps.fs ?? nodeFs;
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const onFailureAlert = deps.onFailureAlert ?? recordBackupFailure;
  const onSuccessAlert = deps.onSuccessAlert ?? clearBackupFailure;

  const recipient = env.BACKUP_AGE_RECIPIENT?.trim();
  if (!recipient) {
    console.error("[backup-database-daily] disabled: BACKUP_AGE_RECIPIENT not set; skipping");
    return { skipped: true };
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("[backup-database-daily] DATABASE_URL is not set");
  }

  const dir = env.BACKUP_DIR?.trim() || DEFAULT_BACKUP_DIR;
  const retainDays = parseRetainDays(env.BACKUP_RETAIN_DAYS);
  const outPath = join(dir, backupFilename(now));

  // Stream pg_dump → age. No shell; no plaintext on disk.
  const dump = spawn("pg_dump", [...pgDumpArgs(databaseUrl)]);
  const enc = spawn("age", [...ageArgs(recipient, outPath)]);

  const dumpErr = collectStderr(dump);
  const encErr = collectStderr(enc);

  // Swallow EPIPE if age dies first so the dump's broken pipe doesn't crash us;
  // the exit-code check below is the real failure signal.
  dump.stdout?.on("error", () => {});
  enc.stdin?.on("error", () => {});
  if (dump.stdout && enc.stdin) dump.stdout.pipe(enc.stdin);

  const [dumpCode, encCode] = await Promise.all([onClose(dump, "pg_dump"), onClose(enc, "age")]);

  if (dumpCode !== 0 || encCode !== 0) {
    // Remove any partial/garbage ciphertext so a failed run can't masquerade as
    // a good backup.
    await fs.unlink(outPath).catch(() => {});
    const message = `[backup-database-daily] failed (pg_dump=${dumpCode} age=${encCode}): ${
      dumpErr.text() || encErr.text() || "no stderr"
    }`;
    // Surface the failure in /alerts (P6-16). Wrapped so an alert-write hiccup
    // can't mask the real backup error we're about to throw.
    await onFailureAlert(now, message).catch(() => {});
    throw new Error(message);
  }

  // Retention: prune stale backups after a confirmed-good write.
  let pruned = 0;
  try {
    const entries = await fs.readdir(dir);
    for (const name of filesToPrune(entries, now, retainDays)) {
      await fs.unlink(join(dir, name)).catch(() => {});
      pruned += 1;
    }
  } catch (err) {
    // Pruning is best-effort; a readdir failure shouldn't fail the backup that
    // already succeeded.
    console.error(
      `[backup-database-daily] prune skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // A good backup clears any open backup_failure alert (P6-16).
  await onSuccessAlert(now).catch(() => {});

  console.error(`[backup-database-daily] wrote ${backupFilename(now)} (pruned ${pruned})`);
  return { outPath, pruned };
}
