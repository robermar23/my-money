// @vitest-environment node
import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { exportBeancountDailyProcessor } from "./export-beancount-daily.ts";

const fakeJob = { id: "test" } as unknown as Job;
const FIXED = new Date("2026-06-07T12:00:00.000Z");

const sampleData = {
  accounts: [
    {
      id: "a1",
      type: "depository" as const,
      institution: "M&T Bank",
      name: "Checking",
      currency: "USD",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ],
  snapshots: [{ accountId: "a1", date: "2026-06-07", balance: "1234.56" }],
  prices: [],
  transactions: [],
};

describe("exportBeancountDailyProcessor", () => {
  it("skips (no write) when BEANCOUNT_DIR is unset", async () => {
    const writeFile = vi.fn();
    const rename = vi.fn();
    const result = await exportBeancountDailyProcessor(fakeJob, {
      env: {},
      fs: { writeFile, rename },
      load: async () => sampleData,
      now: () => FIXED,
    });
    expect(result).toEqual({ skipped: true });
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it("writes atomically: tmp first, then rename to money.beancount", async () => {
    const order: string[] = [];
    const writeFile = vi.fn(async (path: string, content: string) => {
      order.push(`write:${path}`);
      expect(content).toContain("GENERATED");
      expect(content).toContain("2026-06-07 balance Assets:MTBank:Checking 1234.56 USD");
    });
    const rename = vi.fn(async (from: string, to: string) => {
      order.push(`rename:${from}->${to}`);
    });

    const result = await exportBeancountDailyProcessor(fakeJob, {
      env: { BEANCOUNT_DIR: "/exports" },
      fs: { writeFile, rename },
      load: async () => sampleData,
      now: () => FIXED,
    });

    expect(result.path).toBe("/exports/money.beancount");
    expect(order).toEqual([
      "write:/exports/money.beancount.tmp",
      "rename:/exports/money.beancount.tmp->/exports/money.beancount",
    ]);
  });

  it("is deterministic: two runs with the same data + clock write identical content", async () => {
    const contents: string[] = [];
    const fs = {
      writeFile: vi.fn(async (_path: string, content: string) => {
        contents.push(content);
      }),
      rename: vi.fn(async () => {}),
    };
    const deps = {
      env: { BEANCOUNT_DIR: "/exports" },
      fs,
      load: async () => sampleData,
      now: () => FIXED,
    };
    await exportBeancountDailyProcessor(fakeJob, deps);
    await exportBeancountDailyProcessor(fakeJob, deps);
    expect(contents[0]).toBe(contents[1]);
  });
});
