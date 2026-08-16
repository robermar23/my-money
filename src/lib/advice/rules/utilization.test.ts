// @vitest-environment node
import { describe, expect, it } from "vitest";
import { makeAdviceInput, makeDebt } from "../advice-input.fixture.ts";
import { cardUtilizations, overallUtilization, utilizationRule } from "./utilization.ts";

/*
 * P15-19 — credit utilization. Pure: no DB, no clock.
 *
 * The reference wallet: one card at 80% of its limit, one at 5%, and — in the
 * tests that need it — one with no limit recorded at all.
 */

const HOT = makeDebt({
  accountId: "hot",
  accountName: "Rewards card",
  balance: "4000.00",
  creditLimit: "5000.00",
});
const COOL = makeDebt({
  accountId: "cool",
  accountName: "Backup card",
  balance: "500.00",
  creditLimit: "10000.00",
});
const NO_LIMIT = makeDebt({
  accountId: "blank",
  accountName: "Store card",
  balance: "1800.00",
  creditLimit: null,
  missing: ["credit_limit"],
});
const LOAN = makeDebt({
  accountId: "auto",
  accountName: "Auto loan",
  kind: "amortizing",
  balance: "18000.00",
  creditLimit: null,
});

describe("cardUtilizations", () => {
  it("computes the ratio per card and orders by it", () => {
    const cards = cardUtilizations(makeAdviceInput({ debts: [COOL, HOT] }));

    expect(cards.map((c) => c.accountId)).toEqual(["hot", "cool"]);
    expect(cards[0]?.utilization).toBe(0.8);
    expect(cards[1]?.utilization).toBe(0.05);
  });

  it("computes what it would take to get back under the line", () => {
    const [card] = cardUtilizations(makeAdviceInput({ debts: [HOT] }));

    // 30% of a $5,000 limit is $1,500, so $2,500 of the $4,000 has to go.
    expect(card?.amountToTarget).toBe("2500.00");
  });

  it("reports zero to target for a card already under it", () => {
    const [card] = cardUtilizations(makeAdviceInput({ debts: [COOL] }));

    expect(card?.amountToTarget).toBe("0.00");
  });

  it("leaves a loan out entirely — utilization is a revolving concept", () => {
    const cards = cardUtilizations(makeAdviceInput({ debts: [LOAN, HOT] }));

    expect(cards.map((c) => c.accountId)).toEqual(["hot"]);
  });

  it("returns a null ratio, never a guess, when no limit is recorded", () => {
    const cards = cardUtilizations(makeAdviceInput({ debts: [NO_LIMIT, HOT] }));

    expect(cards.map((c) => c.accountId)).toEqual(["hot", "blank"]);
    expect(cards[1]?.utilization).toBeNull();
    expect(cards[1]?.amountToTarget).toBeNull();
  });
});

describe("overallUtilization", () => {
  it("aggregates balances against limits", () => {
    const overall = overallUtilization(makeAdviceInput({ debts: [HOT, COOL] }));

    // $4,500 across $15,000 of limits — exactly 30%.
    expect(overall?.balance).toBe("4500.00");
    expect(overall?.creditLimit).toBe("15000.00");
    expect(overall?.utilization).toBe(0.3);
    expect(overall?.excludedCards).toBe(0);
  });

  it("excludes an unlimited card from BOTH sides and reports what it left out", () => {
    const overall = overallUtilization(makeAdviceInput({ debts: [HOT, COOL, NO_LIMIT] }));

    // Counting the $1,800 balance without its limit would OVERSTATE the ratio;
    // excluding both keeps the ratio honest and flags the coverage gap instead.
    expect(overall?.balance).toBe("4500.00");
    expect(overall?.utilization).toBe(0.3);
    expect(overall?.excludedBalance).toBe("1800.00");
    expect(overall?.excludedCards).toBe(1);
  });

  it("returns null when no card has a limit at all", () => {
    expect(overallUtilization(makeAdviceInput({ debts: [NO_LIMIT] }))).toBeNull();
  });
});

describe("utilizationRule", () => {
  it("flags the card over the line and stays quiet about the one under it", () => {
    const recs = utilizationRule.evaluate(makeAdviceInput({ debts: [HOT, COOL] }));

    expect(recs).toHaveLength(1);
    expect(recs[0]?.subjectKey).toBe("hot");
    expect(recs[0]?.severity).toBe("warning");
    expect(recs[0]?.impact).toBe("2500.00");
    expect(recs[0]?.title).toContain("80.0%");
  });

  it("does not raise an overall finding at exactly the target", () => {
    // $4,500 / $15,000 is 30.0% — the boundary is inclusive, so nothing fires.
    const recs = utilizationRule.evaluate(makeAdviceInput({ debts: [HOT, COOL] }));

    expect(recs.some((r) => r.subjectKey === "overall")).toBe(false);
  });

  it("escalates a nearly-maxed card to critical", () => {
    const [rec] = utilizationRule.evaluate(
      makeAdviceInput({
        debts: [makeDebt({ accountId: "maxed", balance: "4750.00", creditLimit: "5000.00" })],
      }),
    );

    expect(rec?.severity).toBe("critical");
    expect(rec?.currentValue).toBe("95.0");
  });

  it("raises an overall finding when the aggregate is over the line", () => {
    const recs = utilizationRule.evaluate(
      makeAdviceInput({
        debts: [HOT, makeDebt({ accountId: "second", balance: "900.00", creditLimit: "1000.00" })],
      }),
    );

    const overall = recs.find((r) => r.subjectKey === "overall");
    // $4,900 across $6,000 of limits.
    expect(overall?.currentValue).toBe("81.7");
    expect(overall?.severity).toBe("warning");
  });

  it("reports a missing limit as unknown_input against that card", () => {
    const recs = utilizationRule.evaluate(makeAdviceInput({ debts: [NO_LIMIT] }));

    expect(recs).toHaveLength(1);
    expect(recs[0]?.status).toBe("unknown_input");
    expect(recs[0]?.impact).toBeNull();
    expect(recs[0]?.inputsUsed.find((i) => i.missing)?.label).toBe("Credit limit");
    expect(recs[0]?.rationale).toContain("guessed limit");
  });

  it("warns that the overall figure may be understated when a limit is missing", () => {
    const recs = utilizationRule.evaluate(
      makeAdviceInput({
        debts: [
          HOT,
          makeDebt({ accountId: "s", balance: "900.00", creditLimit: "1000.00" }),
          NO_LIMIT,
        ],
      }),
    );
    const overall = recs.find((r) => r.subjectKey === "overall");

    expect(overall?.rationale).toContain("may be higher");
    expect(overall?.confidence).toBe("medium");
  });

  it("says every card is under the line rather than staying silent", () => {
    const [rec] = utilizationRule.evaluate(makeAdviceInput({ debts: [COOL] }));

    expect(rec?.status).toBe("ok");
    expect(rec?.currentValue).toBe("5.0");
    expect(rec?.impact).toBe("0.00");
  });

  it("stays silent for a household with no cards", () => {
    expect(utilizationRule.evaluate(makeAdviceInput({ debts: [LOAN] }))).toHaveLength(0);
  });
});
