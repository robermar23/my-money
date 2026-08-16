// @vitest-environment node
import { describe, expect, it } from "vitest";
import { makeAdviceInput, makeDebt, makeProfile } from "../advice-input.fixture.ts";
import {
  highInterestDebtRule,
  highInterestDebts,
  highInterestThreshold,
} from "./high-interest-debt.ts";

/*
 * P15-17 — the high-interest-debt rule. Pure: no DB, no clock.
 */

const CARD = makeDebt({
  accountId: "card",
  accountName: "Rewards card",
  balance: "5000.00",
  apr: "0.249900",
});
const AUTO = makeDebt({
  accountId: "auto",
  accountName: "Auto loan",
  kind: "amortizing",
  balance: "18000.00",
  apr: "0.089900",
  creditLimit: null,
});
const MORTGAGE = makeDebt({
  accountId: "mortgage",
  accountName: "Mortgage",
  kind: "amortizing",
  balance: "240000.00",
  apr: "0.032500",
  creditLimit: null,
});

describe("highInterestThreshold", () => {
  it("falls back to the checked-in default", () => {
    const threshold = highInterestThreshold(makeAdviceInput());

    expect(threshold.apr).toBe("0.070000");
    expect(threshold.source).toBe("default");
  });

  it("prefers the household setting when one is saved", () => {
    const threshold = highInterestThreshold(
      makeAdviceInput({
        household: { profile: makeProfile({ highInterestThresholdApr: "0.100000" }) },
      }),
    );

    expect(threshold.apr).toBe("0.100000");
    expect(threshold.source).toBe("household");
  });
});

describe("highInterestDebts", () => {
  it("flags only debts above the threshold, worst rate first", () => {
    const flagged = highInterestDebts(makeAdviceInput({ debts: [MORTGAGE, CARD, AUTO] }));

    expect(flagged.map((d) => d.accountId)).toEqual(["card", "auto"]);
  });

  it("moves the line when the household raises the threshold", () => {
    const flagged = highInterestDebts(
      makeAdviceInput({
        debts: [MORTGAGE, CARD, AUTO],
        household: { profile: makeProfile({ highInterestThresholdApr: "0.150000" }) },
      }),
    );

    // The 8.99% auto loan drops off the list entirely at a 15% line.
    expect(flagged.map((d) => d.accountId)).toEqual(["card"]);
  });

  it("ignores a paid-off debt even when its recorded APR is high", () => {
    const flagged = highInterestDebts(
      makeAdviceInput({
        debts: [makeDebt({ accountId: "cleared", balance: "0.00", apr: "0.299900" })],
      }),
    );

    expect(flagged).toHaveLength(0);
  });

  it("never treats a missing APR as 0% — it is unranked, not last", () => {
    const flagged = highInterestDebts(
      makeAdviceInput({
        debts: [makeDebt({ accountId: "unknown", balance: "3000.00", apr: null })],
      }),
    );

    expect(flagged).toHaveLength(0);
  });
});

describe("highInterestDebtRule", () => {
  it("prices a year of interest as the impact figure", () => {
    const [rec] = highInterestDebtRule.evaluate(makeAdviceInput({ debts: [CARD] }));

    // $5,000 at 24.99% costs $1,249.50 over twelve months.
    expect(rec?.status).toBe("action");
    expect(rec?.impact).toBe("1249.50");
    expect(rec?.currentValue).toBe("24.99");
    expect(rec?.benchmark).toBe("7");
  });

  it("escalates to critical at twice the threshold", () => {
    const recs = highInterestDebtRule.evaluate(makeAdviceInput({ debts: [CARD, AUTO] }));

    // 24.99% is past 2 × 7%; 8.99% is over the line but not by that margin.
    expect(recs.find((r) => r.subjectKey === "card")?.severity).toBe("critical");
    expect(recs.find((r) => r.subjectKey === "auto")?.severity).toBe("warning");
  });

  it("names the payoff order in the rationale", () => {
    const recs = highInterestDebtRule.evaluate(makeAdviceInput({ debts: [CARD, AUTO] }));

    expect(recs[0]?.rationale).toContain("highest rate you carry");
    expect(recs[1]?.rationale).toContain("Rewards card");
  });

  it("shows the threshold and its source on every recommendation", () => {
    const [rec] = highInterestDebtRule.evaluate(makeAdviceInput({ debts: [CARD] }));
    const threshold = rec?.inputsUsed.find((i) => i.label === "High-interest threshold");

    expect(threshold?.value).toBe("7");
    expect(threshold?.source).toContain("app default");
    expect(threshold?.href).toBe("/settings/household");
  });

  it("reports a debt with no APR as unknown_input against that account", () => {
    const recs = highInterestDebtRule.evaluate(
      makeAdviceInput({
        debts: [
          makeDebt({
            accountId: "mystery",
            accountName: "Store card",
            balance: "1400.00",
            apr: null,
            status: "unknown_input",
            missing: ["apr"],
          }),
        ],
      }),
    );

    expect(recs).toHaveLength(1);
    expect(recs[0]?.status).toBe("unknown_input");
    expect(recs[0]?.subjectKey).toBe("mystery");
    expect(recs[0]?.impact).toBeNull();
    expect(recs[0]?.rationale).toContain("not being treated as 0%");
    expect(recs[0]?.inputsUsed.find((i) => i.missing)?.label).toBe("APR");
  });

  it("says the debt is all below the line rather than staying silent", () => {
    const [rec] = highInterestDebtRule.evaluate(makeAdviceInput({ debts: [MORTGAGE] }));

    expect(rec?.status).toBe("ok");
    expect(rec?.severity).toBe("info");
    expect(rec?.currentValue).toBe("240000.00");
    expect(rec?.impact).toBe("0.00");
  });

  it("stays silent for a household with no debt", () => {
    expect(highInterestDebtRule.evaluate(makeAdviceInput({ debts: [] }))).toHaveLength(0);
  });

  it("stays silent when every debt is already paid off", () => {
    const recs = highInterestDebtRule.evaluate(
      makeAdviceInput({ debts: [makeDebt({ accountId: "cleared", balance: "0.00" })] }),
    );

    expect(recs).toHaveLength(0);
  });

  it("keeps per-account subject keys so one dismissal does not silence the rest", () => {
    const recs = highInterestDebtRule.evaluate(makeAdviceInput({ debts: [CARD, AUTO] }));

    expect(recs.map((r) => r.id)).toEqual(["high_interest_debt:card", "high_interest_debt:auto"]);
  });
});
