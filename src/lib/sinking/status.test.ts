// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sinkingAvailability } from "./availability.ts";
import { sinkingRequirement } from "./requirement.ts";
import { ROUND12_HORIZON, ROUND12_TODAY, round12Costs, round12Input } from "./round12.fixture.ts";
import { sinkingStatus } from "./status.ts";

/**
 * P18-17 — why a figure is or is not available (ADR-046 §4/§5). Written before
 * the implementation.
 *
 * The function is four lines. It exists because the alternative is the page
 * deciding for itself why the number is missing while the advice rule decides
 * separately, and the two then disagreeing on one screen — which is the failure
 * ADR-032's loader/pure split exists to prevent, applied to a word rather than a
 * number.
 *
 * The important test is the second group: **an empty cost stream is not `ok`.**
 * A household that has recorded nothing has an *unknown* requirement, not a met
 * one, and `ok` would tell a family with an unrecorded $1,340 premium that it is
 * fine. That is the one failure mode that would make this feature actively
 * harmful, it is the thing a future simplification ("the total is zero and the
 * reserve covers zero, so they're on track") would break, and ADR-046 §5 calls
 * it the sharpest judgement call in the phase.
 */

const requirement = (costs = round12Costs()) =>
  sinkingRequirement(costs, ROUND12_TODAY, ROUND12_HORIZON);

describe("sinkingStatus — ok", () => {
  it("is ok when there is a baseline and at least one recorded cost", () => {
    const req = requirement();
    expect(sinkingStatus(req, sinkingAvailability(round12Input(), req))).toBe("ok");
  });

  it("is ok whether the household is ahead or behind", () => {
    // The status says whether the figures can be STATED, not whether they are
    // good news. A $1,580 gap is a perfectly well-known answer.
    const req = requirement();
    const behind = sinkingAvailability(round12Input(), req);
    expect(behind.gap).toBe("1580.00");
    expect(sinkingStatus(req, behind)).toBe("ok");
  });
});

describe("sinkingStatus — no_costs_recorded (ADR-046 §5)", () => {
  const req = requirement([]);
  const availability = sinkingAvailability(round12Input(), req);

  it("is no_costs_recorded when the stream is empty", () => {
    expect(sinkingStatus(req, availability)).toBe("no_costs_recorded");
  });

  it("is NOT ok, even though every figure computed cleanly", () => {
    // Everything is known here: a $9,000 target, $600 available, a $0
    // requirement, a $600 surplus. The arithmetic says "on track" and the app
    // must not: it cannot tell "this household has no large irregular costs"
    // from "it has not recorded them yet", and the second is overwhelmingly
    // likelier on any install.
    expect(req.requiredToday).toBe("0.00");
    expect(availability.surplus).toBe("600.00");
    expect(sinkingStatus(req, availability)).not.toBe("ok");
  });
});

describe("sinkingStatus — no_baseline (ADR-046 §4)", () => {
  const noBaseline = round12Input({ essentials: { baseline: null, trailingMedian: null } });

  it("is no_baseline when the essential baseline is missing", () => {
    const req = requirement();
    expect(sinkingStatus(req, sinkingAvailability(noBaseline, req))).toBe("no_baseline");
  });

  it("takes precedence over no_costs_recorded", () => {
    // Both are true at once on a fresh install. Without a baseline there is no
    // target, so there is no availability to compare a requirement to — the
    // household cannot be told its position either way, and naming the missing
    // baseline is the fix that unblocks the other. One link, not two.
    const req = requirement([]);
    const availability = sinkingAvailability(noBaseline, req);
    expect(req.costCount).toBe(0);
    expect(availability.available).toBeNull();
    expect(sinkingStatus(req, availability)).toBe("no_baseline");
  });
});

describe("sinkingStatus — the vocabulary", () => {
  it("returns one of exactly three values, and nothing else", () => {
    // The union is the page's rendering contract and the rule's branch set; a
    // fourth value would render as a blank section somewhere.
    const cases = [
      sinkingStatus(requirement(), sinkingAvailability(round12Input(), requirement())),
      sinkingStatus(requirement([]), sinkingAvailability(round12Input(), requirement([]))),
      sinkingStatus(
        requirement(),
        sinkingAvailability(
          round12Input({ essentials: { baseline: null, trailingMedian: null } }),
          requirement(),
        ),
      ),
    ];
    expect(cases).toEqual(["ok", "no_costs_recorded", "no_baseline"]);
  });
});
