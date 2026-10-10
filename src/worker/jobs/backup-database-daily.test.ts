// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import {
  ageArgs,
  backupDatabaseDailyProcessor,
  backupFilename,
  filesToPrune,
  parseBackupTimestamp,
  pgDumpArgs,
} from "./backup-database-daily.ts";

const fakeJob = { id: "test" } as unknown as Job;

/* ---------------------------------------------------------------------------
 * Pure helpers
 * --------------------------------------------------------------------------- */

describe("backupFilename / parseBackupTimestamp", () => {
  it("renders a filesystem-safe, sortable name and round-trips", () => {
    const d = new Date("2026-06-07T16:00:00.000Z");
    const name = backupFilename(d);
    expect(name).toBe("money-20260607T160000Z.dump.age");
    expect(parseBackupTimestamp(name)).toBe(d.getTime());
  });

  it("returns null for non-backup filenames", () => {
    expect(parseBackupTimestamp("notes.txt")).toBeNull();
    expect(parseBackupTimestamp("money-bad.dump.age")).toBeNull();
  });
});

describe("pgDumpArgs / ageArgs", () => {
  it("passes DATABASE_URL as a discrete arg (no shell interpolation)", () => {
    const url = "postgres://money:p@ss@postgres:5432/money";
    const args = pgDumpArgs(url);
    expect(args).toEqual(["--format=custom", "--no-password", "--dbname", url]);
    // The URL is a single argv entry — a shell could never re-split it.
    expect(args[3]).toBe(url);
  });

  it("passes the age recipient + output path as discrete args", () => {
    expect(ageArgs("age1xyz", "/backups/money-x.dump.age")).toEqual([
      "--recipient",
      "age1xyz",
      "--output",
      "/backups/money-x.dump.age",
    ]);
  });
});

describe("filesToPrune", () => {
  const now = new Date("2026-06-20T00:00:00.000Z");
  it("prunes backups older than the retain window, keeps newer + unknown files", () => {
    const files = [
      "money-20260601T000000Z.dump.age", // 19 days old → prune (retain 14)
      "money-20260615T000000Z.dump.age", // 5 days old → keep
      "money-20260620T000000Z.dump.age", // today → keep
      "unrelated.txt", // not a backup → never touched
      "money-bad.dump.age", // malformed → ignored
    ];
    expect(filesToPrune(files, now, 14)).toEqual(["money-20260601T000000Z.dump.age"]);
  });

  it("returns nothing when all backups are within the window", () => {
    expect(filesToPrune(["money-20260619T000000Z.dump.age"], now, 14)).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * Orchestration (injected spawn + fs)
 * --------------------------------------------------------------------------- */

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
}

function makeFakeSpawn(opts: { dumpCode?: number; ageCode?: number } = {}) {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const spawn = ((cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const code = cmd === "pg_dump" ? (opts.dumpCode ?? 0) : (opts.ageCode ?? 0);
    process.nextTick(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code);
    });
    return child;
    // biome-ignore lint/suspicious/noExplicitAny: minimal spawn stand-in for tests
  }) as any;
  return { spawn, calls };
}

const FIXED_NOW = new Date("2026-06-07T16:00:00.000Z");

describe("backupDatabaseDailyProcessor", () => {
  it("skips (no spawn) when BACKUP_AGE_RECIPIENT is unset", async () => {
    const { spawn, calls } = makeFakeSpawn();
    const onNotConfiguredAlert = vi.fn(async () => {});
    const result = await backupDatabaseDailyProcessor(fakeJob, {
      spawn,
      env: { DATABASE_URL: "postgres://x" },
      fs: { readdir: vi.fn(), unlink: vi.fn() },
      now: () => FIXED_NOW,
      onNotConfiguredAlert,
    });
    expect(result).toEqual({ skipped: true });
    expect(calls).toHaveLength(0);
    // P19-08: the skip is reported, not just logged.
    expect(onNotConfiguredAlert).toHaveBeenCalledWith(FIXED_NOW);
  });

  it("still skips cleanly when the not-configured alert write fails", async () => {
    const { spawn } = makeFakeSpawn();
    const result = await backupDatabaseDailyProcessor(fakeJob, {
      spawn,
      env: { DATABASE_URL: "postgres://x" },
      fs: { readdir: vi.fn(), unlink: vi.fn() },
      now: () => FIXED_NOW,
      onNotConfiguredAlert: async () => {
        throw new Error("db down");
      },
    });
    expect(result).toEqual({ skipped: true });
  });

  it("streams pg_dump → age with correct args and prunes stale backups", async () => {
    const { spawn, calls } = makeFakeSpawn();
    const unlink = vi.fn(async () => {});
    const readdir = vi.fn(async () => [
      "money-20260101T000000Z.dump.age", // way old → prune
      "money-20260607T160000Z.dump.age", // today → keep
    ]);
    const url = "postgres://money:secret@postgres:5432/money";

    const result = await backupDatabaseDailyProcessor(fakeJob, {
      spawn,
      env: { DATABASE_URL: url, BACKUP_AGE_RECIPIENT: "age1abc", BACKUP_DIR: "/backups" },
      fs: { readdir, unlink },
      now: () => FIXED_NOW,
      onFailureAlert: async () => {},
      onSuccessAlert: async () => {},
    });

    expect(calls[0]?.cmd).toBe("pg_dump");
    expect(calls[0]?.args).toEqual(["--format=custom", "--no-password", "--dbname", url]);
    expect(calls[1]?.cmd).toBe("age");
    expect(calls[1]?.args).toEqual([
      "--recipient",
      "age1abc",
      "--output",
      "/backups/money-20260607T160000Z.dump.age",
    ]);
    expect(result.outPath).toBe("/backups/money-20260607T160000Z.dump.age");
    expect(result.pruned).toBe(1);
    expect(unlink).toHaveBeenCalledWith("/backups/money-20260101T000000Z.dump.age");
  });

  it("throws and removes the partial file when pg_dump fails", async () => {
    const { spawn } = makeFakeSpawn({ dumpCode: 1 });
    const unlink = vi.fn(async () => {});
    await expect(
      backupDatabaseDailyProcessor(fakeJob, {
        spawn,
        env: { DATABASE_URL: "postgres://x", BACKUP_AGE_RECIPIENT: "age1abc", BACKUP_DIR: "/b" },
        fs: { readdir: vi.fn(async () => []), unlink },
        now: () => FIXED_NOW,
        onFailureAlert: async () => {},
        onSuccessAlert: async () => {},
      }),
    ).rejects.toThrow(/pg_dump=1/);
    expect(unlink).toHaveBeenCalledWith("/b/money-20260607T160000Z.dump.age");
  });
});
