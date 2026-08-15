// @vitest-environment node
import { describe, expect, it } from "vitest";
import { basisProvenance } from "./basis-provenance.ts";

/**
 * P14-16 — the flags behind the "tracked from contributions" annotation.
 *
 * Small surface, but it decides whether the user is told a cost-basis figure
 * came from their own contribution rule and whether the share quantity behind it
 * is real or manual. Getting either backwards mislabels a real dollar figure.
 */

describe("basisProvenance", () => {
  it("reports nothing for a holding with no lots", () => {
    expect(basisProvenance([])).toEqual({
      fromContributions: false,
      hasBasisOnlyContributions: false,
    });
  });

  it("ignores manual and Plaid lots", () => {
    const result = basisProvenance([
      { quantity: "10", source: "manual" },
      { quantity: "0", source: "plaid" },
    ]);
    // A zero-quantity PLAID lot is not a basis-only contribution — the flag is
    // about contributions specifically, not about zero quantities in general.
    expect(result).toEqual({ fromContributions: false, hasBasisOnlyContributions: false });
  });

  it("flags a priced contribution lot without claiming it is basis-only", () => {
    const result = basisProvenance([{ quantity: "1.23456789", source: "income" }]);
    expect(result.fromContributions).toBe(true);
    expect(result.hasBasisOnlyContributions).toBe(false);
  });

  it("flags a zero-quantity contribution lot as basis-only", () => {
    // ADR-031 §3: an unpriceable contribution records full basis and no shares
    // rather than inventing a quantity.
    const result = basisProvenance([{ quantity: "0.00000000", source: "income" }]);
    expect(result).toEqual({ fromContributions: true, hasBasisOnlyContributions: true });
  });

  it("flags a mixed holding on both counts", () => {
    // A rule that lost its price feed part-way through the year — some periods
    // bought shares, some recorded basis only.
    const result = basisProvenance([
      { quantity: "2.5", source: "income" },
      { quantity: "0", source: "income" },
      { quantity: "100", source: "manual" },
    ]);
    expect(result).toEqual({ fromContributions: true, hasBasisOnlyContributions: true });
  });
});
