// @vitest-environment node
import { db } from "@/db/client.ts";
import { alerts, priceTargets, watchlistItems } from "@/db/schema/index.ts";
import type { PriceTargetInput } from "@/lib/alerts/rules.ts";
import type { Job } from "bullmq";
import { eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluatePriceTargetsProcessor } from "./evaluate-price-targets.ts";

const fakeJob = { id: "test" } as unknown as Job;
const NOW = new Date("2026-06-07T12:00:00.000Z");
const noEnvNotify = vi.fn(async () => ({ sent: false }));

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE watchlist_items, price_targets, alerts CASCADE`);
}

/** Seed a watchlist item + an active target; return the target id. */
async function seedTarget(direction: "above" | "below", threshold: string): Promise<string> {
  const [item] = await db
    .insert(watchlistItems)
    .values({ symbol: "AAPL", assetClass: "equity" })
    .returning({ id: watchlistItems.id });
  if (!item) throw new Error("seed failed");
  const [target] = await db
    .insert(priceTargets)
    .values({ watchlistItemId: item.id, direction, threshold })
    .returning({ id: priceTargets.id, watchlistItemId: priceTargets.watchlistItemId });
  if (!target) throw new Error("seed failed");
  return target.id;
}

function hitInput(targetId: string, over: Partial<PriceTargetInput> = {}): PriceTargetInput {
  return {
    targetId,
    watchlistItemId: "wl",
    symbol: "AAPL",
    direction: "above",
    threshold: "200.00000000",
    latestClose: "205.00000000",
    latestDate: "2026-06-07",
    currency: "USD",
    ...over,
  };
}

describe("evaluatePriceTargetsProcessor", () => {
  beforeEach(reset);
  afterAll(reset);

  it("a hit target produces one alert and flips the target inactive", async () => {
    const targetId = await seedTarget("above", "200.00000000");
    const result = await evaluatePriceTargetsProcessor(fakeJob, {
      now: () => NOW,
      notify: noEnvNotify,
      load: async () => [hitInput(targetId)],
    });
    expect(result.created).toBe(1);
    expect(result.triggered).toBe(1);

    const [alert] = await db.select().from(alerts).where(eq(alerts.type, "price_target"));
    expect(alert?.title).toBe("AAPL hit your above target");

    const [row] = await db.select().from(priceTargets).where(eq(priceTargets.id, targetId));
    expect(row?.active).toBe(false);
    expect(row?.triggeredPrice).toBe("205.00000000");
    expect(row?.triggeredAt).not.toBeNull();
  });

  it("is a no-op on re-run (dedup + already-inactive target)", async () => {
    const targetId = await seedTarget("above", "200.00000000");
    const deps = {
      now: () => NOW,
      notify: noEnvNotify,
      load: async () => [hitInput(targetId)],
    };
    await evaluatePriceTargetsProcessor(fakeJob, deps);
    // Real loader would now skip the inactive target; simulate by loading nothing.
    const second = await evaluatePriceTargetsProcessor(fakeJob, {
      ...deps,
      load: async () => [],
    });
    expect(second.created).toBe(0);
    expect(second.triggered).toBe(0);
    expect(await db.$count(alerts)).toBe(1);
  });

  it("a missed target does nothing", async () => {
    const targetId = await seedTarget("above", "300.00000000");
    const result = await evaluatePriceTargetsProcessor(fakeJob, {
      now: () => NOW,
      notify: noEnvNotify,
      load: async () => [
        hitInput(targetId, { threshold: "300.00000000", latestClose: "205.00000000" }),
      ],
    });
    expect(result.created).toBe(0);
    expect(result.triggered).toBe(0);

    const [row] = await db.select().from(priceTargets).where(eq(priceTargets.id, targetId));
    expect(row?.active).toBe(true);
    expect(await db.$count(alerts)).toBe(0);
  });

  it("notifies content-free for the open alert and stamps notified_at on send", async () => {
    const targetId = await seedTarget("above", "200.00000000");
    const notify = vi.fn(async () => ({ sent: true }));
    const result = await evaluatePriceTargetsProcessor(fakeJob, {
      now: () => NOW,
      notify,
      load: async () => [hitInput(targetId)],
    });
    expect(notify).toHaveBeenCalledWith(1, "2026-06-07");
    expect(result.notified).toBe(1);

    const open = await db.select().from(alerts).where(isNull(alerts.resolvedAt));
    expect(open[0]?.notifiedAt).not.toBeNull();
  });
});
