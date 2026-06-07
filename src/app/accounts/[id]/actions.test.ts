// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, holdingLots, holdings } from "@/db/schema/index.ts";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

/* ---------------------------------------------------------------------------
 * Mocks: requireUser (needs cookies) + next/cache. DB runs for real.
 * --------------------------------------------------------------------------- */

vi.mock("@/lib/auth/require-user.ts", () => ({
  requireUser: vi.fn(async () => ({
    id: "00000000-0000-0000-0000-000000000001",
    passwordHash: "fake",
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { addLotAction, deleteLotAction } = await import("./actions.ts");

async function seedHolding(): Promise<{ accountId: string; holdingId: string }> {
  await db.execute(sql`TRUNCATE accounts, holdings, holding_lots CASCADE`);
  const [account] = await db
    .insert(accounts)
    .values({ name: "Fidelity", institution: "Fidelity", type: "investment", currency: "USD" })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account");
  const [holding] = await db
    .insert(holdings)
    .values({
      accountId: account.id,
      symbol: "AAPL",
      quantity: "10",
      quantityUnit: "shares",
      assetClass: "equity",
      source: "manual",
    })
    .returning({ id: holdings.id });
  if (!holding) throw new Error("seed holding");
  return { accountId: account.id, holdingId: holding.id };
}

function lotForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

afterEach(() => vi.clearAllMocks());

describe("addLotAction (P5-18)", () => {
  it("inserts a manual lot and stamps the holding's cost_basis_overridden_at", async () => {
    const { accountId, holdingId } = await seedHolding();

    const result = await addLotAction(
      accountId,
      holdingId,
      {},
      lotForm({ acquiredAt: "2026-01-15", quantity: "10", costBasisTotal: "1000.00" }),
    );
    expect(result.ok).toBe(true);

    const lots = await db.select().from(holdingLots).where(eq(holdingLots.holdingId, holdingId));
    expect(lots).toHaveLength(1);
    expect(lots[0]?.costBasisTotal).toBe("1000.00");
    expect(lots[0]?.acquiredAt).toBe("2026-01-15");
    expect(lots[0]?.source).toBe("manual");

    const [h] = await db.select().from(holdings).where(eq(holdings.id, holdingId));
    expect(h?.costBasisOverriddenAt).toBeInstanceOf(Date);
  });

  it("rejects a malformed holding id without writing", async () => {
    const { accountId } = await seedHolding();
    const result = await addLotAction(
      accountId,
      "not-a-uuid",
      {},
      lotForm({ quantity: "1", costBasisTotal: "1.00" }),
    );
    expect(result.error).toBeTruthy();
    expect(await db.select().from(holdingLots)).toHaveLength(0);
  });

  it("rejects an invalid quantity", async () => {
    const { accountId, holdingId } = await seedHolding();
    const result = await addLotAction(
      accountId,
      holdingId,
      {},
      lotForm({ quantity: "abc", costBasisTotal: "1.00" }),
    );
    expect(result.error).toBeTruthy();
    expect(await db.select().from(holdingLots)).toHaveLength(0);
  });
});

describe("deleteLotAction (P5-18)", () => {
  it("removes a lot belonging to the holding", async () => {
    const { accountId, holdingId } = await seedHolding();
    await addLotAction(
      accountId,
      holdingId,
      {},
      lotForm({ quantity: "10", costBasisTotal: "1000.00" }),
    );
    const [lot] = await db.select().from(holdingLots).where(eq(holdingLots.holdingId, holdingId));
    if (!lot) throw new Error("expected a lot");

    const result = await deleteLotAction(accountId, holdingId, lot.id);
    expect(result.ok).toBe(true);
    expect(
      await db.select().from(holdingLots).where(eq(holdingLots.holdingId, holdingId)),
    ).toHaveLength(0);
  });
});
