import { INCOME_CADENCES } from "@/db/schema/income-sources.ts";
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { OBLIGATION_CADENCES } from "./cadence.ts";

describe("OBLIGATION_CADENCES", () => {
  it("declares the seven obligation cadences in ascending period length", () => {
    expect(OBLIGATION_CADENCES).toEqual([
      "weekly",
      "biweekly",
      "semimonthly",
      "monthly",
      "quarterly",
      "semiannual",
      "annual",
    ]);
  });

  it("is a superset of the income cadences (ADR-037 §3)", () => {
    // The compile-time assertion in cadence.ts is the real gate; this is its
    // runtime twin, so a divergence is caught by `pnpm test` as well as `tsc`.
    for (const cadence of INCOME_CADENCES) {
      expect(OBLIGATION_CADENCES).toContain(cadence);
    }
  });
});
