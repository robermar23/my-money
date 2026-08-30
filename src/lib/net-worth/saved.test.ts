// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FlowVerdict } from "./boundary.ts";
import type { FlowTxn } from "./flow-types.ts";
import { savedFromFlows } from "./saved.ts";

/**
 * P17-05 — `saved`, per ADR-041 §1.
 *
 * `saved` is a CASH-FLOW figure: external inflows minus external outflows over
 * the window. It is emphatically not "the change in your cash balances", and
 * the difference is the whole reason the rung is trustworthy. Deriving it from
 * balance deltas would make the identity reconcile *by construction* — the
 * residual would be zero on every book, forever, and the one genuinely useful
 * output of this phase would be a constant.
 *
 * Because it is a cash-flow figure it can be negative, and the tests say so
 * out loud: a household that spent more than it earned this month has a
 * negative `saved`, not a zero one.
 */

function classified(
  id: string,
  amount: string,
  verdict: FlowVerdict,
): { txn: FlowTxn; verdict: FlowVerdict } {
  return {
    txn: {
      id,
      accountId: "checking",
      postedAt: "2026-03-10",
      amount,
      name: "ROW",
      categoryId: verdict === "uncategorized" ? null : "cat-1",
      categoryKind:
        verdict === "uncategorized"
          ? null
          : verdict === "inflow"
            ? "income"
            : verdict === "outflow"
              ? "expense"
              : "transfer",
    },
    verdict,
  };
}

describe("savedFromFlows", () => {
  it("sums income only", () => {
    const result = savedFromFlows([
      classified("a", "3200.00", "inflow"),
      classified("b", "150.00", "inflow"),
    ]);

    expect(result.saved).toBe("3350.00");
    expect(result.inflow).toBe("3350.00");
    expect(result.outflow).toBe("0.00");
  });

  it("sums expenses only, reporting outflow as a positive magnitude", () => {
    const result = savedFromFlows([
      classified("a", "-84.20", "outflow"),
      classified("b", "-15.80", "outflow"),
    ]);

    expect(result.saved).toBe("-100.00");
    expect(result.inflow).toBe("0.00");
    expect(result.outflow).toBe("100.00");
  });

  it("returns a NEGATIVE saved for a month that spent more than it earned", () => {
    const result = savedFromFlows([
      classified("a", "3200.00", "inflow"),
      classified("b", "-4000.00", "outflow"),
    ]);

    expect(result.saved).toBe("-800.00");
  });

  it("nets a refund against the expense category it was posted to", () => {
    // A positive amount on an expense row reduces outflow. It does not become
    // income — see the sign case in boundary.test.ts.
    const result = savedFromFlows([
      classified("a", "-84.20", "outflow"),
      classified("b", "84.20", "outflow"),
    ]);

    expect(result.saved).toBe("0.00");
    expect(result.outflow).toBe("0.00");
  });

  it("reports 0.00 with no volume when every row is a paired transfer", () => {
    // Internal moves are invisible to every figure here. A household that spent
    // its month shuffling money between its own accounts saved nothing and
    // moved nothing, and the diagnostics must not imply otherwise.
    const result = savedFromFlows([
      classified("a", "-500.00", "internal"),
      classified("b", "500.00", "internal"),
    ]);

    expect(result).toEqual({
      saved: "0.00",
      inflow: "0.00",
      outflow: "0.00",
      unpairedTransferVolume: "0.00",
      uncategorizedVolume: "0.00",
      uncategorizedCount: 0,
    });
  });

  it("counts uncategorized rows as volume but never as saved", () => {
    // ADR-040 §5: `NULL` is not `0.00`. The app says how much it could not
    // classify rather than assuming the classification — the same posture
    // `spendingSummary` already takes.
    const result = savedFromFlows([
      classified("a", "3200.00", "inflow"),
      classified("b", "-220.00", "uncategorized"),
      classified("c", "40.00", "uncategorized"),
    ]);

    expect(result.saved).toBe("3200.00");
    expect(result.uncategorizedVolume).toBe("260.00");
    expect(result.uncategorizedCount).toBe(2);
  });

  it("reports unpaired transfer volume as an unsigned magnitude", () => {
    const result = savedFromFlows([
      classified("a", "-500.00", "unpaired_transfer"),
      classified("b", "-250.00", "unpaired_transfer"),
    ]);

    expect(result.saved).toBe("0.00");
    expect(result.unpairedTransferVolume).toBe("750.00");
  });

  it("returns all-zero for an empty window rather than throwing", () => {
    expect(savedFromFlows([])).toEqual({
      saved: "0.00",
      inflow: "0.00",
      outflow: "0.00",
      unpairedTransferVolume: "0.00",
      uncategorizedVolume: "0.00",
      uncategorizedCount: 0,
    });
  });
});
