import { sinkingFundRule } from "@/lib/advice/rules/sinking-fund.ts";
import { describe, expect, it } from "vitest";
import { sinkingAvailability } from "./availability.ts";
import { sinkingInputsUsed } from "./inputs.ts";
import { sinkingHorizon, sinkingRequirement } from "./requirement.ts";
import { ROUND12_TODAY, round12Costs, round12Input } from "./round12.fixture.ts";

/**
 * The audit trail is ONE list, read by two renderers (P18-22, ADR-046
 * consequence 1).
 *
 * The figures were already shared — the rule and the loader both call
 * [requirement.ts](./requirement.ts) and [availability.ts](./availability.ts),
 * so neither can state a different number. The `inputsUsed` list was the one
 * part that was not, and a divergence there is the quieter failure of the two:
 * the page and the card would agree on $2,180 and disagree about **where it came
 * from**, which is precisely the question a user opens the audit trail to answer.
 *
 * So the strongest assertion in this file is not that the list has the right
 * labels — the rule's own suite already covers that — but that the two consumers
 * get the **same** list, in all three branches of the status ladder.
 */

function build(input: ReturnType<typeof round12Input>) {
  const requirement = sinkingRequirement(
    input.knownFutureCosts,
    input.today,
    sinkingHorizon(input.today, input.currency),
  );
  const availability = sinkingAvailability(input, requirement);
  return { requirement, availability };
}

describe("sinkingInputsUsed — one list, two renderers", () => {
  it("matches the rule's own audit trail on a stated figure", () => {
    const input = round12Input({ knownFutureCosts: round12Costs() });
    const { requirement, availability } = build(input);

    const [recommendation] = sinkingFundRule.evaluate(input);

    expect(recommendation?.inputsUsed).toEqual(sinkingInputsUsed(input, requirement, availability));
  });

  it("matches the rule when nothing has been recorded", () => {
    const input = round12Input({ knownFutureCosts: [] });
    const { requirement, availability } = build(input);

    const [recommendation] = sinkingFundRule.evaluate(input);

    expect(recommendation?.inputsUsed).toEqual(sinkingInputsUsed(input, requirement, availability));
  });

  it("matches the rule when there is no essential baseline", () => {
    const input = round12Input({
      knownFutureCosts: round12Costs(),
      essentials: { baseline: null },
    });
    const { requirement, availability } = build(input);

    const [recommendation] = sinkingFundRule.evaluate(input);

    expect(recommendation?.inputsUsed).toEqual(sinkingInputsUsed(input, requirement, availability));
  });

  it("names six inputs on a stated figure, in the order a reader checks them", () => {
    const input = round12Input({ knownFutureCosts: round12Costs() });
    const { requirement, availability } = build(input);

    expect(sinkingInputsUsed(input, requirement, availability).map((i) => i.label)).toEqual([
      "Set aside required today",
      "Reserve savings",
      "Emergency-fund target",
      "Reserve above your emergency-fund target",
      "Essential monthly expenses",
      "Reserve target",
    ]);
  });

  it("names the cost list as the missing input when nothing is recorded", () => {
    const input = round12Input({ knownFutureCosts: [] });
    const { requirement, availability } = build(input);

    const inputs = sinkingInputsUsed(input, requirement, availability);
    const costs = inputs.find((i) => i.label === "Known upcoming costs");

    expect(costs?.value).toBeNull();
    expect(costs?.missing).toBe(true);
    expect(costs?.href).toBe("/plan/sinking");
    // The horizon is named rather than described, so a reader can tell which 12
    // months the app looked at.
    expect(costs?.source).toContain(ROUND12_TODAY);
  });

  it("lists two inputs and no cost count when the baseline is missing", () => {
    const input = round12Input({
      knownFutureCosts: round12Costs(),
      essentials: { baseline: null },
    });
    const { requirement, availability } = build(input);

    // A count of `0` presented as a known value would be the `null` ≠ `"0.00"`
    // mistake moved into the audit trail. See the rule's header.
    expect(sinkingInputsUsed(input, requirement, availability).map((i) => i.label)).toEqual([
      "Essential monthly expenses",
      "Reserve savings",
    ]);
  });

  it("is pure — two calls on one input give equal lists", () => {
    const input = round12Input({ knownFutureCosts: round12Costs() });
    const { requirement, availability } = build(input);

    expect(sinkingInputsUsed(input, requirement, availability)).toEqual(
      sinkingInputsUsed(input, requirement, availability),
    );
  });
});
