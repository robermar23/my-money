// @vitest-environment node
import { db } from "@/db/client.ts";
import { recommendationDismissals } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Mocks: requireUser (needs cookies) + next/cache. DB runs for real. */
vi.mock("@/lib/auth/require-user.ts", () => ({
  requireUser: vi.fn(async () => ({
    id: "00000000-0000-0000-0000-000000000001",
    passwordHash: "fake",
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { dismissRecommendationAction, restoreRecommendationAction } = await import("./actions.ts");

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE recommendation_dismissals CASCADE`);
});
afterEach(() => vi.clearAllMocks());

describe("dismissRecommendationAction (P15-34)", () => {
  it("dismisses indefinitely when no snooze is given", async () => {
    const res = await dismissRecommendationAction({}, form({ ruleId: "emergency_fund" }));

    expect(res.ok).toBe(true);
    const [row] = await db.select().from(recommendationDismissals);
    expect(row?.ruleId).toBe("emergency_fund");
    expect(row?.subjectKey).toBe("");
    expect(row?.snoozeUntil).toBeNull();
  });

  it("converts snooze days into an absolute expiry", async () => {
    // The row stores an instant, not a duration: the engine asks "is this
    // timestamp in the past yet", which a stored `30` could not answer.
    const before = Date.now();
    await dismissRecommendationAction({}, form({ ruleId: "cash_drag", snoozeDays: "30" }));

    const [row] = await db.select().from(recommendationDismissals);
    const expiry = row?.snoozeUntil?.getTime() ?? 0;
    expect(expiry).toBeGreaterThan(before + 29 * 86_400_000);
    expect(expiry).toBeLessThan(before + 31 * 86_400_000);
  });

  it("keeps the subject key so one card's dismissal spares the other", async () => {
    await dismissRecommendationAction(
      {},
      form({ ruleId: "credit_utilization", subjectKey: "card-a" }),
    );

    const [row] = await db.select().from(recommendationDismissals);
    expect(row?.subjectKey).toBe("card-a");
  });

  it("rejects a missing rule id without writing", async () => {
    const res = await dismissRecommendationAction({}, form({ ruleId: "" }));

    expect(res.error).toBeTruthy();
    expect(await db.$count(recommendationDismissals)).toBe(0);
  });

  it("rejects a snooze past the one-year bound", async () => {
    // Beyond a year a snooze is a dismissal with extra steps, and an unbounded
    // one would let a stray keystroke silence a rule for decades.
    const res = await dismissRecommendationAction(
      {},
      form({ ruleId: "cash_drag", snoozeDays: "4000" }),
    );

    expect(res.error).toContain("365");
    expect(await db.$count(recommendationDismissals)).toBe(0);
  });

  it("rejects a non-numeric snooze", async () => {
    const res = await dismissRecommendationAction(
      {},
      form({ ruleId: "cash_drag", snoozeDays: "soon" }),
    );

    expect(res.error).toBeTruthy();
    expect(await db.$count(recommendationDismissals)).toBe(0);
  });
});

describe("restoreRecommendationAction (P15-34)", () => {
  it("removes the dismissal so the item returns on the next read", async () => {
    await dismissRecommendationAction({}, form({ ruleId: "emergency_fund" }));

    const res = await restoreRecommendationAction("emergency_fund", "");

    expect(res.ok).toBe(true);
    expect(await db.$count(recommendationDismissals)).toBe(0);
  });

  it("treats undoing a non-existent dismissal as success", async () => {
    // "I want to see this again" is a statement about the desired end state, and
    // that state already holds. Erroring would be pedantry.
    expect(await restoreRecommendationAction("emergency_fund", "")).toEqual({ ok: true });
  });

  it("refuses a blank rule id", async () => {
    expect((await restoreRecommendationAction("", "")).error).toBeTruthy();
  });
});
