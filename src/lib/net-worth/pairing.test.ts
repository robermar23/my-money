// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FlowTxn } from "./flow-types.ts";
import { DEFAULT_PAIRING, type PairingOptions, pairTransfers } from "./pairing.ts";

/**
 * P17-04 — transfer pairing, expressed as a DATA CONTRACT.
 *
 * These cases were written and watched fail before `pairing.ts` existed
 * (`test-driven-development`), because the failure mode here is silent. Both
 * directions move real money between two rungs while the total still
 * reconciles:
 *
 *   - A **missed** pair treats an internal move as money leaving the household.
 *     `saved` falls by the full amount, nothing adds it back, and `unexplained`
 *     absorbs the difference. A family that moved $10,000 from checking to
 *     savings reads that it spent $10,000.
 *   - A **wrong** pair treats a real external payment as internal. `saved`
 *     never sees it, so the app reports a household saving money it actually
 *     sent away. This is the dangerous direction, because it flatters.
 *
 * Neither error changes `delta`, which comes from `computeNetWorth` and is a
 * fact. That is exactly why P17-13 asserts the rungs individually — a
 * decomposition that reconciles is not thereby correct.
 *
 * The blocks below are quality dimensions, following `match.test.ts`:
 *   validity     — a pair needs opposite signs, another account, the window, the tolerance
 *   uniqueness   — one leg is claimed by at most one pair
 *   completeness — every transfer row is either paired or reported unpaired
 *   determinism  — the same rows produce byte-identical output in any order
 */

/** Typed factory. A transfer row unless `categoryKind` says otherwise. */
function txn(over: Partial<FlowTxn> & Pick<FlowTxn, "id" | "accountId" | "amount">): FlowTxn {
  return {
    postedAt: "2026-03-10",
    name: "TRANSFER",
    categoryId: "cat-xfer",
    categoryKind: "transfer",
    ...over,
  };
}

describe("pairTransfers", () => {
  describe("validity", () => {
    it("pairs an exact same-day two-leg move", () => {
      const rows = [
        txn({ id: "a1", accountId: "checking", amount: "-500.00" }),
        txn({ id: "b1", accountId: "savings", amount: "500.00" }),
      ];

      const result = pairTransfers(rows);

      expect(result.pairs).toEqual([{ fromId: "a1", toId: "b1", amount: "500.00", dayGap: 0 }]);
      expect(result.unpairedIds).toEqual([]);
    });

    it("pairs a two-day-lagged move, because ACH does not settle same-day", () => {
      const rows = [
        txn({ id: "a1", accountId: "checking", amount: "-500.00", postedAt: "2026-03-10" }),
        txn({ id: "b1", accountId: "savings", amount: "500.00", postedAt: "2026-03-12" }),
      ];

      const result = pairTransfers(rows);

      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0]?.dayGap).toBe(2);
    });

    it("does NOT pair two legs in the SAME account", () => {
      // Two rows in one account are not a move between accounts. Pairing them
      // would erase a real outflow and a real inflow from `saved` at once.
      const rows = [
        txn({ id: "a1", accountId: "checking", amount: "-500.00" }),
        txn({ id: "a2", accountId: "checking", amount: "500.00" }),
      ];

      const result = pairTransfers(rows);

      expect(result.pairs).toEqual([]);
      expect(result.unpairedIds).toEqual(["a1", "a2"]);
    });

    it("does NOT pair a leg outside the window", () => {
      const rows = [
        txn({ id: "a1", accountId: "checking", amount: "-500.00", postedAt: "2026-03-01" }),
        txn({ id: "b1", accountId: "savings", amount: "500.00", postedAt: "2026-03-20" }),
      ];

      expect(pairTransfers(rows).pairs).toEqual([]);
    });

    it("pairs at exactly the window edge and not one day past it", () => {
      // The edge case, not merely a case: a suite that only tests a leg 19 days
      // away cannot tell a 5-day window from a 6-day one, and a window quietly
      // one day wider pairs transfers that are not the same move. Caught by
      // mutation-checking this suite (`windowDays + 1` survived until this
      // test existed).
      const at = (postedAt: string): readonly FlowTxn[] => [
        txn({ id: "a1", accountId: "checking", amount: "-500.00", postedAt: "2026-03-10" }),
        txn({ id: "b1", accountId: "savings", amount: "500.00", postedAt }),
      ];

      expect(DEFAULT_PAIRING.windowDays).toBe(5);
      expect(pairTransfers(at("2026-03-15")).pairs).toHaveLength(1);
      expect(pairTransfers(at("2026-03-16")).pairs).toEqual([]);
      // Symmetric: a leg may post BEFORE its counterparty just as easily.
      expect(pairTransfers(at("2026-03-05")).pairs).toHaveLength(1);
      expect(pairTransfers(at("2026-03-04")).pairs).toEqual([]);
    });

    it("pairs an amount just INSIDE tolerance and not one just OUTSIDE", () => {
      // The tolerance is one cent, deliberately too small to absorb a wire fee.
      // See the rationale on DEFAULT_PAIRING.
      const inside = [
        txn({ id: "a1", accountId: "checking", amount: "-500.00" }),
        txn({ id: "b1", accountId: "savings", amount: "499.99" }),
      ];
      const outside = [
        txn({ id: "a1", accountId: "checking", amount: "-500.00" }),
        txn({ id: "b1", accountId: "savings", amount: "499.98" }),
      ];

      expect(pairTransfers(inside).pairs).toHaveLength(1);
      expect(pairTransfers(outside).pairs).toEqual([]);
    });

    it("never pairs rows that are not transfers", () => {
      // A paycheck and a savings deposit are not two legs of one move, however
      // neatly the amounts line up.
      const rows = [
        txn({ id: "a1", accountId: "checking", amount: "-500.00", categoryKind: "expense" }),
        txn({ id: "b1", accountId: "savings", amount: "500.00", categoryKind: "income" }),
        txn({ id: "c1", accountId: "checking", amount: "-500.00", categoryKind: null }),
      ];

      const result = pairTransfers(rows);

      expect(result.pairs).toEqual([]);
      // Non-transfer rows are not "unpaired transfers" either. Reporting them
      // would inflate the unpaired-transfer diagnostic with ordinary spending.
      expect(result.unpairedIds).toEqual([]);
    });
  });

  describe("uniqueness", () => {
    it("claims each leg once, so three legs yield one pair and one orphan", () => {
      const rows = [
        txn({ id: "a1", accountId: "checking", amount: "-500.00" }),
        txn({ id: "b1", accountId: "savings", amount: "500.00" }),
        txn({ id: "c1", accountId: "brokerage", amount: "500.00" }),
      ];

      const result = pairTransfers(rows);

      expect(result.pairs).toHaveLength(1);
      expect(result.unpairedIds).toHaveLength(1);
      const claimed = [result.pairs[0]?.fromId, result.pairs[0]?.toId];
      expect(claimed).not.toContain(result.unpairedIds[0]);
    });

    it("does not let two outflows both claim the SAME inflow leg", () => {
      // The case above has only one outflow, so it never exercises the claim
      // set at all — dropping the one-claim rule left it green. Without the
      // rule, one $500 arrival would satisfy two $500 departures, and `saved`
      // would lose $500 of real spending to a second internal verdict that no
      // second transaction supports.
      const rows = [
        txn({ id: "a1", accountId: "checking", amount: "-500.00" }),
        txn({ id: "a2", accountId: "brokerage", amount: "-500.00" }),
        txn({ id: "b1", accountId: "savings", amount: "500.00" }),
      ];

      const result = pairTransfers(rows);

      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0]).toEqual({ fromId: "a1", toId: "b1", amount: "500.00", dayGap: 0 });
      expect(result.unpairedIds).toEqual(["a2"]);
    });
  });

  describe("determinism", () => {
    it("prefers the NEAREST date among two candidate counterparties", () => {
      const rows = [
        txn({ id: "a1", accountId: "checking", amount: "-500.00", postedAt: "2026-03-10" }),
        txn({ id: "far", accountId: "savings", amount: "500.00", postedAt: "2026-03-13" }),
        txn({ id: "near", accountId: "brokerage", amount: "500.00", postedAt: "2026-03-11" }),
      ];

      expect(pairTransfers(rows).pairs[0]?.toId).toBe("near");
    });

    it("breaks a date tie on the smaller amount difference", () => {
      const rows = [
        txn({ id: "a1", accountId: "checking", amount: "-500.00" }),
        txn({ id: "loose", accountId: "savings", amount: "499.99" }),
        txn({ id: "exact", accountId: "brokerage", amount: "500.00" }),
      ];

      expect(pairTransfers(rows).pairs[0]?.toId).toBe("exact");
    });

    it("breaks a full tie on the lowest id", () => {
      const rows = [
        txn({ id: "a1", accountId: "checking", amount: "-500.00" }),
        txn({ id: "z-leg", accountId: "savings", amount: "500.00" }),
        txn({ id: "b-leg", accountId: "brokerage", amount: "500.00" }),
      ];

      expect(pairTransfers(rows).pairs[0]?.toId).toBe("b-leg");
    });

    it("is independent of input row order", () => {
      const rows = [
        txn({ id: "a1", accountId: "checking", amount: "-500.00", postedAt: "2026-03-10" }),
        txn({ id: "a2", accountId: "checking", amount: "-250.00", postedAt: "2026-03-11" }),
        txn({ id: "b1", accountId: "savings", amount: "500.00", postedAt: "2026-03-11" }),
        txn({ id: "b2", accountId: "savings", amount: "250.00", postedAt: "2026-03-12" }),
        txn({ id: "orphan", accountId: "savings", amount: "-75.00", postedAt: "2026-03-11" }),
      ];

      const forward = pairTransfers(rows);
      const reversed = pairTransfers([...rows].reverse());

      expect(reversed).toEqual(forward);
      expect(forward.pairs).toHaveLength(2);
      expect(forward.unpairedIds).toEqual(["orphan"]);
    });
  });

  describe("options", () => {
    it("honours a widened window", () => {
      const rows = [
        txn({ id: "a1", accountId: "checking", amount: "-500.00", postedAt: "2026-03-01" }),
        txn({ id: "b1", accountId: "savings", amount: "500.00", postedAt: "2026-03-09" }),
      ];
      const wide: PairingOptions = { ...DEFAULT_PAIRING, windowDays: 10 };

      expect(pairTransfers(rows).pairs).toEqual([]);
      expect(pairTransfers(rows, wide).pairs).toHaveLength(1);
    });

    it("rejects a negative window or tolerance rather than pairing nothing", () => {
      // Silently pairing nothing would report every internal move as money
      // leaving the household, which is indistinguishable from a family that
      // emptied its accounts.
      expect(() => pairTransfers([], { windowDays: -1, amountAbs: "0.01" })).toThrow();
      expect(() => pairTransfers([], { windowDays: 5, amountAbs: "-0.01" })).toThrow();
    });
  });
});
