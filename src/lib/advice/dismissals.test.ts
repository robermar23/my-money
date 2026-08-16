// @vitest-environment node
import { db } from "@/db/client.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { makeAdviceInput } from "./advice-input.fixture.ts";
import { dismissRecommendation, listDismissals, undismissRecommendation } from "./dismissals.ts";
import { runAdvice } from "./engine.ts";

/* Real DB, like the other query modules — the UPSERT is the thing under test. */

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE recommendation_dismissals CASCADE`);
}

beforeEach(reset);

describe("dismissRecommendation", () => {
  it("stores an indefinite dismissal", async () => {
    const row = await dismissRecommendation("emergency_fund", "", null);

    expect(row.ruleId).toBe("emergency_fund");
    expect(row.subjectKey).toBe("");
    expect(row.snoozeUntil).toBeNull();
  });

  it("stores a snooze with its expiry", async () => {
    const until = new Date("2026-12-01T00:00:00Z");
    const row = await dismissRecommendation("cash_drag", "", until);

    expect(row.snoozeUntil?.toISOString()).toBe(until.toISOString());
  });

  it("writes one row when the same item is dismissed twice", async () => {
    // The UNIQUE on (rule_id, subject_key) plus ON CONFLICT: a double-click, or a
    // user changing their mind from snooze to permanent, must not accumulate rows.
    await dismissRecommendation("credit_utilization", "card-a", new Date("2026-09-01"));
    await dismissRecommendation("credit_utilization", "card-a", null);

    const rows = await listDismissals();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.snoozeUntil).toBeNull();
  });

  it("keeps per-subject dismissals separate", async () => {
    // The property `subject_key` exists for: hiding one card must not hide the
    // other.
    await dismissRecommendation("credit_utilization", "card-a", null);
    await dismissRecommendation("credit_utilization", "card-b", null);

    expect(await listDismissals()).toHaveLength(2);
  });

  it("restamps dismissed_at on a repeat dismissal", async () => {
    const first = new Date("2026-01-01T00:00:00Z");
    const second = new Date("2026-06-01T00:00:00Z");
    await dismissRecommendation("cash_drag", "", null, first);
    await dismissRecommendation("cash_drag", "", null, second);

    const [row] = await listDismissals();
    expect(row?.dismissedAt.toISOString()).toBe(second.toISOString());
  });

  it("rejects a blank rule id at the database boundary", async () => {
    // The CHECK exists because an empty rule id would be a silent catch-all,
    // suppressing every rule at once.
    await expect(dismissRecommendation("", "", null)).rejects.toThrow();
  });
});

describe("undismissRecommendation", () => {
  it("removes the row and reports that it did", async () => {
    await dismissRecommendation("emergency_fund", "", null);

    expect(await undismissRecommendation("emergency_fund", "")).toBe(true);
    expect(await listDismissals()).toEqual([]);
  });

  it("is a no-op on a dismissal that does not exist", async () => {
    expect(await undismissRecommendation("emergency_fund", "")).toBe(false);
  });

  it("removes only the named subject", async () => {
    await dismissRecommendation("credit_utilization", "card-a", null);
    await dismissRecommendation("credit_utilization", "card-b", null);

    await undismissRecommendation("credit_utilization", "card-a");

    const rows = await listDismissals();
    expect(rows.map((r) => r.subjectKey)).toEqual(["card-b"]);
  });
});

describe("listDismissals feeding the engine", () => {
  it("suppresses a rule the user dismissed, and reports it as suppressed", async () => {
    // The round trip that matters: what the table stores is exactly what
    // `runAdvice` consumes, with no adapter in between to get wrong.
    await dismissRecommendation("waterfall", "", null);

    const input = makeAdviceInput();
    const result = runAdvice(input, await listDismissals(), new Date("2026-08-15T12:00:00Z"));

    expect(result.recommendations.some((r) => r.ruleId === "waterfall")).toBe(false);
    expect(result.suppressed.some((s) => s.recommendation.ruleId === "waterfall")).toBe(true);
  });

  it("lets an expired snooze bring the item back on its own", async () => {
    await dismissRecommendation("waterfall", "", new Date("2026-08-01T00:00:00Z"));

    const input = makeAdviceInput();
    const result = runAdvice(input, await listDismissals(), new Date("2026-08-15T12:00:00Z"));

    expect(result.recommendations.some((r) => r.ruleId === "waterfall")).toBe(true);
    expect(result.suppressed).toEqual([]);
  });

  it("keeps the row after the snooze expires, so the rejection stays inspectable", async () => {
    await dismissRecommendation("waterfall", "", new Date("2026-08-01T00:00:00Z"));

    expect(await listDismissals()).toHaveLength(1);
  });

  it("still suppresses while the snooze is live", async () => {
    await dismissRecommendation("waterfall", "", new Date("2026-09-01T00:00:00Z"));

    const result = runAdvice(
      makeAdviceInput(),
      await listDismissals(),
      new Date("2026-08-15T12:00:00Z"),
    );

    expect(result.suppressed.some((s) => s.recommendation.ruleId === "waterfall")).toBe(true);
  });
});
