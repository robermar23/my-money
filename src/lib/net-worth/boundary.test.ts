// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyFlow, classifyFlows } from "./boundary.ts";
import type { FlowTxn } from "./flow-types.ts";

/**
 * P17-03 — the household boundary, per ADR-040.
 *
 * The question every case below asks is the same one: *did this money cross the
 * household boundary?* Not "was it spending", not "was it planned income" —
 * only whether net worth could have moved. Five verdicts, and three of them are
 * "no" for three different reasons that the user needs told apart.
 */

function txn(over: Partial<FlowTxn> & Pick<FlowTxn, "id" | "amount">): FlowTxn {
  return {
    accountId: "checking",
    postedAt: "2026-03-10",
    name: "ACME",
    categoryId: "cat-1",
    categoryKind: "expense",
    ...over,
  };
}

describe("classifyFlow", () => {
  it("classifies an income row as an inflow", () => {
    expect(
      classifyFlow(txn({ id: "t1", amount: "3200.00", categoryKind: "income" }), new Set()),
    ).toBe("inflow");
  });

  it("classifies an expense row as an outflow", () => {
    expect(
      classifyFlow(txn({ id: "t1", amount: "-84.20", categoryKind: "expense" }), new Set()),
    ).toBe("outflow");
  });

  it("classifies a PAIRED transfer as internal", () => {
    const row = txn({ id: "t1", amount: "-500.00", categoryKind: "transfer" });

    expect(classifyFlow(row, new Set(["t1"]))).toBe("internal");
  });

  it("classifies the SAME transfer as unpaired when no counterparty was found", () => {
    // Same row, same category, different verdict. That is ADR-040 §1 in one
    // assertion: `kind` states intent, pairing establishes what happened.
    const row = txn({ id: "t1", amount: "-500.00", categoryKind: "transfer" });

    expect(classifyFlow(row, new Set())).toBe("unpaired_transfer");
  });

  it("classifies a row with no category as uncategorized", () => {
    const row = txn({ id: "t1", amount: "-500.00", categoryId: null, categoryKind: null });

    expect(classifyFlow(row, new Set())).toBe("uncategorized");
  });

  it("still treats an excluded-from-baseline income row as an inflow", () => {
    // ADR-040 §4, and the divergence from ADR-034 §1 that the header explains.
    // A reimbursement is excluded from *take-home* because you cannot plan
    // against it; it is included *here* because it is real money that really
    // arrived and really moved net worth. Excluding it would manufacture a
    // residual out of money the household actually received.
    //
    // The guarantee is structural rather than behavioural: `FlowTxn` has no
    // `excludedFromBaseline` field for the classifier to read, so the loader
    // cannot project the flag into this layer even by accident. The line below
    // is a COMPILE-TIME regression test — if a future change adds the field,
    // the `@ts-expect-error` goes unused and `tsc` fails.
    // @ts-expect-error `excludedFromBaseline` is deliberately absent from FlowTxn (ADR-040 §4)
    type _NoBaselineFlag = FlowTxn["excludedFromBaseline"];

    const reimbursement = txn({
      id: "t1",
      amount: "412.00",
      name: "EXPENSE REIMBURSEMENT",
      categoryKind: "income",
    });

    expect(classifyFlow(reimbursement, new Set())).toBe("inflow");
  });

  it("ignores sign when deciding the verdict", () => {
    // A refund posted against an expense category is still an expense row. The
    // verdict states which side of the boundary the row sits on; the SIGN is
    // what `savedFromFlows` arithmetic reads, and conflating the two would make
    // a refund look like income.
    const refund = txn({ id: "t1", amount: "84.20", categoryKind: "expense" });

    expect(classifyFlow(refund, new Set())).toBe("outflow");
  });
});

describe("classifyFlows", () => {
  it("classifies every row once, preserving input order", () => {
    const rows = [
      txn({ id: "a", amount: "3200.00", categoryKind: "income" }),
      txn({ id: "b", amount: "-500.00", categoryKind: "transfer" }),
      txn({ id: "c", amount: "-20.00", categoryId: null, categoryKind: null }),
    ];

    const out = classifyFlows(rows, new Set(["b"]));

    expect(out.map((c) => [c.txn.id, c.verdict])).toEqual([
      ["a", "inflow"],
      ["b", "internal"],
      ["c", "uncategorized"],
    ]);
  });
});
