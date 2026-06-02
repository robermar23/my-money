// @vitest-environment node
import { db } from "@/db/client.ts";
import { plaidItems } from "@/db/schema/index.ts";
import { createPlaidItem } from "@/lib/plaid/tokens.ts";
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ---------------------------------------------------------------------------
 * The fan-out processor only enqueues into syncPlaidItemQueue — no Plaid SDK
 * calls, no DB writes (only reads). Mock the queue to capture jobIds + payload.
 * --------------------------------------------------------------------------- */

interface AddArgs {
  data: { plaidItemPk?: string; trigger?: string };
  opts: { jobId?: string };
}
const mockAdd = vi.fn<
  (name: string, data: AddArgs["data"], opts: AddArgs["opts"]) => Promise<{ id: string }>
>(async () => ({ id: "fanout-test" }));
vi.mock("@/lib/queue/queues.ts", () => ({
  QUEUE_NAMES: { SYNC_PLAID_ITEM: "sync-plaid-item" },
  syncPlaidItemQueue: { add: mockAdd },
}));

const { enqueuePlaidSyncsDailyProcessor } = await import("./enqueue-plaid-syncs-daily.ts");

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE plaid_sync_runs, plaid_items CASCADE`);
}

async function seedItem(
  plaidItemId: string,
  status: "active" | "login_required" | "pending_disconnect" | "revoked" | "removed",
): Promise<string> {
  const pk = await createPlaidItem({
    plaidItemId,
    institutionId: "ins_test",
    institutionName: "Test Bank",
    accessToken: `tok-${plaidItemId}`,
    productsConsented: ["transactions"],
  });
  if (status !== "active") {
    await db.update(plaidItems).set({ status }).where(eq(plaidItems.id, pk));
  }
  return pk;
}

beforeEach(async () => {
  await reset();
  mockAdd.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("enqueuePlaidSyncsDailyProcessor (P4-27)", () => {
  it("enqueues a cron sync for every active Item — and only active Items", async () => {
    const a = await seedItem("item-active-a", "active");
    const b = await seedItem("item-active-b", "active");
    await seedItem("item-login", "login_required");
    await seedItem("item-pending", "pending_disconnect");
    await seedItem("item-revoked", "revoked");
    await seedItem("item-removed", "removed");

    const result = await enqueuePlaidSyncsDailyProcessor({} as Job);

    expect(result.enqueued).toBe(2);
    expect(mockAdd).toHaveBeenCalledTimes(2);

    const enqueuedPks = mockAdd.mock.calls.map((c) => c[1]?.plaidItemPk).sort();
    expect(enqueuedPks).toEqual([a, b].sort());

    for (const call of mockAdd.mock.calls) {
      expect(call[0]).toBe("sync-plaid-item");
      expect(call[1]?.trigger).toBe("cron");
      // jobId pins idempotency for same-day re-fires (DST hop, manual replay).
      expect(call[2]?.jobId).toMatch(/^sync-plaid-item-cron-\d{4}-\d{2}-\d{2}-[0-9a-f-]{36}$/);
    }
  });

  it("is a no-op when no Items are active", async () => {
    await seedItem("item-only-broken", "login_required");
    await seedItem("item-only-removed", "removed");

    const result = await enqueuePlaidSyncsDailyProcessor({} as Job);

    expect(result.enqueued).toBe(0);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("returns 0 when there are no Items at all", async () => {
    const result = await enqueuePlaidSyncsDailyProcessor({} as Job);
    expect(result.enqueued).toBe(0);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("uses a date-stamped jobId so two same-day fires collapse to one", async () => {
    await seedItem("item-once", "active");
    // First fire.
    await enqueuePlaidSyncsDailyProcessor({} as Job);
    const firstJobId = mockAdd.mock.calls[0]?.[2]?.jobId;
    mockAdd.mockClear();
    // Second fire moments later.
    await enqueuePlaidSyncsDailyProcessor({} as Job);
    const secondJobId = mockAdd.mock.calls[0]?.[2]?.jobId;
    // Same date → identical jobId → BullMQ collapses to one job in real Redis.
    expect(firstJobId).toBe(secondJobId);
  });
});
