// @vitest-environment node
import { db } from "@/db/client.ts";
import { accountSnapshots, accounts } from "@/db/schema/index.ts";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ---------------------------------------------------------------------------
 * Mocks: requireUser (needs cookies). DB runs for real. `redirect` throws
 * NEXT_REDIRECT on success — caught at the call site (same posture as the
 * [id]/actions delete test).
 * --------------------------------------------------------------------------- */

vi.mock("@/lib/auth/require-user.ts", () => ({
  requireUser: vi.fn(async () => ({
    id: "00000000-0000-0000-0000-000000000001",
    passwordHash: "fake",
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
}));

const { createAssetAction } = await import("./actions.ts");

function assetForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE accounts, account_snapshots CASCADE`);
});
afterEach(() => vi.clearAllMocks());

describe("createAssetAction (P10-04)", () => {
  it("creates a personal_asset account with the sentinel institution + asset columns", async () => {
    await createAssetAction(
      {},
      assetForm({
        name: "2021 Tacoma",
        assetCategory: "vehicle",
        description: "TRD Off-Road, white",
        acquiredAt: "2021-03-10",
        acquisitionCost: "38000.00",
      }),
    ).catch(() => undefined); // redirect throws on success

    const [acc] = await db.select().from(accounts);
    expect(acc?.type).toBe("personal_asset");
    expect(acc?.institution).toBe("Personal asset");
    expect(acc?.assetCategory).toBe("vehicle");
    expect(acc?.description).toBe("TRD Off-Road, white");
    expect(acc?.acquiredAt).toBe("2021-03-10");
    expect(acc?.acquisitionCost).toBe("38000.00");

    // No initial value → no snapshot → stays off the dashboard until valued.
    expect(await db.select().from(accountSnapshots)).toHaveLength(0);
  });

  it("writes an initial-value snapshot when supplied", async () => {
    await createAssetAction(
      {},
      assetForm({
        name: "Rolex",
        assetCategory: "jewelry",
        initialValue: "11000.00",
        initialValueDate: "2026-06-20",
      }),
    ).catch(() => undefined);

    const [acc] = await db.select().from(accounts);
    if (!acc) throw new Error("expected asset");
    const snaps = await db
      .select()
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, acc.id));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.balance).toBe("11000.00");
    expect(snaps[0]?.date).toBe("2026-06-20");
  });

  it("defaults the initial-value date to today when only a value is given", async () => {
    await createAssetAction(
      {},
      assetForm({ name: "Painting", assetCategory: "collectible", initialValue: "2500.00" }),
    ).catch(() => undefined);

    const [snap] = await db.select().from(accountSnapshots);
    expect(snap?.balance).toBe("2500.00");
    expect(snap?.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it("rejects an unknown category without writing", async () => {
    const res = await createAssetAction(
      {},
      assetForm({ name: "x", assetCategory: "spaceship" }),
    ).catch(() => undefined);
    expect(res?.error).toBeTruthy();
    expect(await db.select().from(accounts)).toHaveLength(0);
  });
});
