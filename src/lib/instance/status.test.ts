// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DRILL_DUE_AFTER_DAYS,
  WORKER_STALE_AFTER_MS,
  drillStatus,
  limitCoverage,
  migrationStatus,
  workerLiveness,
} from "./status.ts";

const JOURNAL = [
  { tag: "0000_first", when: 1000 },
  { tag: "0001_second", when: 2000 },
  { tag: "0002_third", when: 3000 },
];

describe("migrationStatus", () => {
  it("is current when the newest applied migration is the image's newest", () => {
    expect(migrationStatus(JOURNAL, 3000)).toEqual({ kind: "current", latest: "0002_third" });
  });

  it("names the pending migrations when the database is behind", () => {
    expect(migrationStatus(JOURNAL, 1000)).toEqual({
      kind: "behind",
      applied: "0000_first",
      latest: "0002_third",
      pending: ["0001_second", "0002_third"],
    });
  });

  it("treats a never-migrated database as behind by everything", () => {
    const status = migrationStatus(JOURNAL, null);
    expect(status.kind).toBe("behind");
    expect(status.kind === "behind" && status.applied).toBeNull();
    expect(status.kind === "behind" && status.pending).toHaveLength(3);
  });

  it("reports a database newer than the image (an older image was pulled)", () => {
    expect(migrationStatus(JOURNAL, 4000)).toEqual({ kind: "ahead", latest: "0002_third" });
  });

  it("uses drizzle's timestamp rule, not a row count", () => {
    // A hand-repaired history with an unknown applied timestamp between two
    // known ones: drizzle would apply only the later migration.
    expect(migrationStatus(JOURNAL, 2500)).toMatchObject({
      kind: "behind",
      applied: null,
      pending: ["0002_third"],
    });
  });

  it("does not throw on an empty journal", () => {
    expect(migrationStatus([], null)).toEqual({ kind: "empty" });
  });
});

describe("workerLiveness", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");

  it("is alive within the stale window", () => {
    expect(workerLiveness(now.getTime() - 60_000, now).kind).toBe("alive");
    expect(workerLiveness(now.getTime() - WORKER_STALE_AFTER_MS, now).kind).toBe("alive");
  });

  it("is stale past it", () => {
    expect(workerLiveness(now.getTime() - WORKER_STALE_AFTER_MS - 1, now).kind).toBe("stale");
  });

  it("is never when no heartbeat has completed", () => {
    expect(workerLiveness(null, now)).toEqual({ kind: "never" });
  });
});

describe("drillStatus", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

  it("is never until one is recorded", () => {
    expect(drillStatus(null, now)).toEqual({ kind: "never" });
  });

  it("is not due inside a quarter", () => {
    expect(drillStatus(daysAgo(DRILL_DUE_AFTER_DAYS), now)).toMatchObject({
      ageDays: DRILL_DUE_AFTER_DAYS,
      due: false,
    });
  });

  it("is due after a quarter", () => {
    expect(drillStatus(daysAgo(DRILL_DUE_AFTER_DAYS + 1), now)).toMatchObject({ due: true });
  });
});

describe("limitCoverage", () => {
  const years = [2024, 2025, 2026];

  it("names next year as the first gap while this year is covered", () => {
    expect(limitCoverage(years, 2026)).toEqual({
      years,
      currentYearConfigured: true,
      firstMissingYear: 2027,
    });
  });

  it("names this year when it has expired", () => {
    expect(limitCoverage(years, 2027)).toMatchObject({
      currentYearConfigured: false,
      firstMissingYear: 2027,
    });
  });

  it("stays quiet when the gap is more than a year out", () => {
    expect(limitCoverage([2025, 2026, 2027], 2025).firstMissingYear).toBeNull();
  });
});
