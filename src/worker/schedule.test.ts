// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEDULES, type SchedulerId, repeatFor } from "./schedule.ts";

const ids = Object.keys(SCHEDULES) as SchedulerId[];

describe("SCHEDULES", () => {
  it("keeps every pattern exactly as it was before P19-24", () => {
    expect(Object.fromEntries(ids.map((id) => [id, SCHEDULES[id].pattern]))).toEqual({
      "fetch-prices-daily-cron": "30 1 * * *",
      "materialize-contributions-cron": "45 1 * * *",
      "compute-snapshots-daily-cron": "0 2 * * *",
      "enqueue-plaid-syncs-daily-cron": "0 3 * * *",
      "backup-database-daily-cron": "0 4 * * *",
      "export-beancount-daily-cron": "30 4 * * *",
      "detect-anomalies-daily-cron": "0 5 * * *",
      "refresh-fundamentals-weekly-cron": "0 6 * * 0",
      "detect-obligations-weekly-cron": "30 6 * * 0",
    });
  });

  it("lets only the jobs that write no figure follow the operator's zone", () => {
    const operator = ids.filter((id) => SCHEDULES[id].clock === "operator");
    expect(operator).toEqual(["backup-database-daily-cron", "export-beancount-daily-cron"]);
  });
});

describe("repeatFor", () => {
  it("pins the data chain to UTC whatever TZ says", () => {
    for (const id of ids.filter((i) => SCHEDULES[i].clock === "utc")) {
      expect(repeatFor(id, "Australia/Sydney")).toEqual({
        pattern: SCHEDULES[id].pattern,
        tz: "UTC",
      });
    }
  });

  it("runs the operator jobs in the operator's zone, and on UTC when TZ is unset", () => {
    expect(repeatFor("backup-database-daily-cron", "Australia/Sydney").tz).toBe("Australia/Sydney");
    for (const id of ids) expect(repeatFor(id, "UTC").tz).toBe("UTC");
  });
});

describe("worker entrypoint", () => {
  const source = readFileSync("src/worker/index.ts", "utf8");

  it("schedules every cron job through the table", () => {
    for (const id of ids) {
      expect(source, id).toContain(`repeatFor("${id}", operatorZone)`);
    }
  });

  it("has no cron pattern of its own, so none can bypass a clock", () => {
    expect(source).not.toMatch(/pattern:/);
  });
});
