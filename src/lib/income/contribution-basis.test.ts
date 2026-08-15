// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, holdingLots, holdings } from "@/db/schema/index.ts";
import { basisProvenance } from "@/lib/investments/basis-provenance.ts";
import { gainLoss } from "@/lib/investments/gain-loss.ts";
import { resolveCostBasis } from "@/lib/investments/lots.ts";
import { listInvestmentLots } from "@/lib/investments/queries.ts";
import { Money } from "@/lib/money/money.ts";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * P14-16 — the claim the whole phase rests on: **what you contributed IS your
 * cost basis**, with no change to the investment machinery.
 *
 * `lots.ts` and `gain-loss.ts` are already tested in isolation, and the
 * materialization job is tested on what it writes. Neither one proves the seam
 * between them: that a `source='income'` lot travels the *real read path* —
 * `listInvestmentLots` → `resolveCostBasis` → `gainLoss` — and lands on the
 * pages as a real basis and a real gain. That seam is what turns a 401k's "—"
 * into a number, so it gets a test of its own rather than being assumed.
 */

const USD = "USD";

async function reset(): Promise<void> {
  await db.execute(sql`TRUNCATE holding_lots, holdings, accounts CASCADE`);
}

/** A 401k holding funded by two biweekly contributions of $270 each. */
async function seedContributedHolding(over: { readonly quantity: string } = { quantity: "0" }) {
  const [account] = await db
    .insert(accounts)
    .values({ name: "401k", institution: "Fidelity", type: "investment", currency: USD })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed account failed");

  const [holding] = await db
    .insert(holdings)
    .values({
      accountId: account.id,
      symbol: "FXAIX",
      quantity: over.quantity,
      quantityUnit: "shares",
      assetClass: "equity",
      // Deliberately null: an employer plan reports no basis. This is the "—"
      // the phase exists to replace.
      costBasis: null,
    })
    .returning({ id: holdings.id });
  if (!holding) throw new Error("seed holding failed");
  return { accountId: account.id, holdingId: holding.id };
}

describe("contribution lots as cost basis", () => {
  beforeEach(reset);
  afterAll(reset);

  it("turns contributed dollars into the holding's cost basis and gain/loss", async () => {
    const { holdingId } = await seedContributedHolding({ quantity: "3.00000000" });
    await db.insert(holdingLots).values([
      {
        holdingId,
        acquiredAt: "2026-01-02",
        quantity: "1.50000000",
        costBasisTotal: "270.00",
        source: "income",
      },
      {
        holdingId,
        acquiredAt: "2026-01-16",
        quantity: "1.50000000",
        costBasisTotal: "270.00",
        source: "income",
      },
    ]);

    const lots = await listInvestmentLots();
    expect(lots).toHaveLength(2);
    expect(lots.every((l) => l.source === "income")).toBe(true);

    // The precedence rule (ADR-012) needs no special case for contributions:
    // lots exist, so lots win over the null aggregate.
    const basis = resolveCostBasis({ costBasis: null }, lots, USD);
    expect(basis?.toString()).toBe("540.00");

    // …and gain/loss is now a real figure instead of "—".
    const gl = gainLoss({ value: Money.fromString("600.00", USD), costBasis: basis as Money });
    expect(gl.absolute?.toString()).toBe("60.00");
    expect(gl.percent).toBe("11.11");
  });

  it("keeps basis-only contributions in the basis while flagging the manual quantity", async () => {
    // ADR-031 §3: an unpriceable contribution records the full dollars with a
    // zero share count rather than inventing one. The dollars must still count
    // toward basis — dropping them would understate what the user put in.
    const { holdingId } = await seedContributedHolding({ quantity: "10.00000000" });
    await db.insert(holdingLots).values({
      holdingId,
      acquiredAt: "2026-01-02",
      quantity: "0",
      costBasisTotal: "270.00",
      source: "income",
    });

    const lots = await listInvestmentLots();
    expect(resolveCostBasis({ costBasis: null }, lots, USD)?.toString()).toBe("270.00");

    // The position's 10 shares are the user's own entry, not something the
    // contribution bought — which is exactly what the page annotates.
    const provenance = basisProvenance(lots);
    expect(provenance).toEqual({ fromContributions: true, hasBasisOnlyContributions: true });
  });

  it("sums contributed and manually entered lots together", async () => {
    // A rollover recorded by hand plus ongoing payroll contributions: one basis,
    // two provenances. Nothing about `source` changes the arithmetic.
    const { holdingId } = await seedContributedHolding({ quantity: "5.00000000" });
    await db.insert(holdingLots).values([
      {
        holdingId,
        acquiredAt: "2025-06-01",
        quantity: "4.00000000",
        costBasisTotal: "1000.00",
        source: "manual",
      },
      {
        holdingId,
        acquiredAt: "2026-01-02",
        quantity: "1.00000000",
        costBasisTotal: "270.00",
        source: "income",
      },
    ]);

    const lots = await listInvestmentLots();
    expect(resolveCostBasis({ costBasis: null }, lots, USD)?.toString()).toBe("1270.00");
    expect(basisProvenance(lots).fromContributions).toBe(true);
  });
});
