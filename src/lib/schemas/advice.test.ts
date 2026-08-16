// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  accountTermsSchema,
  bulkClassifySchema,
  categoryClassificationSchema,
  creditLineTermsSchema,
  householdMemberSchema,
  householdProfileSchema,
} from "./advice.ts";

/*
 * P15-28 — the Zod boundary for every column Phase 15 added.
 *
 * Two properties are worth more than the rest of this file combined:
 *
 *   1. Blank means "not recorded" everywhere, and must PASS. NULL is meaningful
 *      in all of these columns (ADR-033 §1) and a schema that demanded a value
 *      would force the user to invent one — which is precisely the confident
 *      wrong number this phase exists to avoid.
 *   2. The unit guard. An APR typed the way a statement prints it (24.99) must
 *      be rejected, because a 2499% card produces a payoff plan that is not
 *      merely wrong but absurd.
 */

/** Assert a failure and return the message the user would see. */
function messageOf(result: {
  success: boolean;
  error?: { issues: { message: string }[] };
}): string {
  expect(result.success).toBe(false);
  return result.error?.issues[0]?.message ?? "";
}

describe("accountTermsSchema", () => {
  it("accepts an entirely blank form — every column is nullable on purpose", () => {
    const parsed = accountTermsSchema.safeParse({
      subtype: "",
      apy: "",
      maturityDate: "",
      taxTreatment: "",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts a CD with a maturity date and a yield", () => {
    const parsed = accountTermsSchema.safeParse({
      subtype: "cd",
      apy: "4.5",
      maturityDate: "2027-03-01",
      taxTreatment: "",
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a maturity date on anything that is not a CD", () => {
    // Not hygiene: a maturity date on a checking account means the user thinks
    // the app will do something with it.
    const message = messageOf(
      accountTermsSchema.safeParse({
        subtype: "checking",
        apy: "",
        maturityDate: "2027-03-01",
        taxTreatment: "",
      }),
    );

    expect(message).toContain("only applies to a CD");
  });

  it("rejects a maturity date with no subtype set at all", () => {
    expect(
      accountTermsSchema.safeParse({ subtype: "", apy: "", maturityDate: "2027-03-01" }).success,
    ).toBe(false);
  });

  it("reads APY as a percentage, not a fraction", () => {
    // 100 is the ceiling; 4.5 means 4.5%. A user typing 0.045 gets a legal (if
    // unattractive) 0.045% — the schema cannot read minds, and the field's help
    // text carries that instead.
    expect(accountTermsSchema.safeParse({ apy: "4.5" }).success).toBe(true);
    expect(accountTermsSchema.safeParse({ apy: "0.045" }).success).toBe(true);
    expect(accountTermsSchema.safeParse({ apy: "100" }).success).toBe(true);
    expect(messageOf(accountTermsSchema.safeParse({ apy: "450" }))).toContain("between 0 and 100");
    expect(accountTermsSchema.safeParse({ apy: "-1" }).success).toBe(false);
    expect(accountTermsSchema.safeParse({ apy: "four" }).success).toBe(false);
  });

  it("rejects a subtype outside the CHECK vocabulary", () => {
    expect(accountTermsSchema.safeParse({ subtype: "brokerage" }).success).toBe(false);
  });

  it("rejects a tax treatment outside the CHECK vocabulary", () => {
    expect(accountTermsSchema.safeParse({ taxTreatment: "401k" }).success).toBe(false);
    expect(accountTermsSchema.safeParse({ taxTreatment: "roth" }).success).toBe(true);
  });
});

describe("creditLineTermsSchema", () => {
  it("accepts a card where only the limit is known", () => {
    // The engine reports the missing APR as unknown_input rather than assuming
    // zero — so a partial entry has to be a legal entry.
    const parsed = creditLineTermsSchema.safeParse({ apr: "", creditLimit: "5000.00" });

    expect(parsed.success).toBe(true);
  });

  it("rejects an APR typed the way a statement prints it", () => {
    // THE data-entry error of this phase: 24.99 as a fraction is a 2499% card.
    const message = messageOf(creditLineTermsSchema.safeParse({ apr: "24.99" }));

    expect(message).toContain("decimal fraction");
    expect(message).toContain("0.2499");
  });

  it("accepts the same APR expressed correctly", () => {
    expect(creditLineTermsSchema.safeParse({ apr: "0.2499" }).success).toBe(true);
    expect(creditLineTermsSchema.safeParse({ apr: "0" }).success).toBe(true);
    expect(creditLineTermsSchema.safeParse({ apr: "1" }).success).toBe(true);
    expect(creditLineTermsSchema.safeParse({ apr: "-0.01" }).success).toBe(false);
  });

  it("allows a flat minimum and a percentage minimum together", () => {
    // Issuers bill the greater of the two; the payoff engine takes the max.
    expect(
      creditLineTermsSchema.safeParse({ minimumPayment: "35.00", minimumPaymentPercent: "2" })
        .success,
    ).toBe(true);
  });

  it("reads the minimum-payment percent as a percentage", () => {
    expect(messageOf(creditLineTermsSchema.safeParse({ minimumPaymentPercent: "200" }))).toContain(
      "between 0 and 100",
    );
  });

  it("rejects negative money figures", () => {
    expect(messageOf(creditLineTermsSchema.safeParse({ creditLimit: "-100.00" }))).toContain(
      "cannot be negative",
    );
    expect(messageOf(creditLineTermsSchema.safeParse({ minimumPayment: "-35.00" }))).toContain(
      "cannot be negative",
    );
  });

  it("rejects a limit with more than two decimal places", () => {
    expect(creditLineTermsSchema.safeParse({ creditLimit: "5000.123" }).success).toBe(false);
  });

  it("bounds the notes field", () => {
    expect(creditLineTermsSchema.safeParse({ notes: "x".repeat(501) }).success).toBe(false);
    expect(creditLineTermsSchema.safeParse({ notes: "Balance transfer ends June" }).success).toBe(
      true,
    );
  });
});

describe("categoryClassificationSchema", () => {
  const ID = "11111111-1111-4111-8111-111111111111";

  it("accepts each necessity value", () => {
    for (const necessity of ["essential", "discretionary", "savings"]) {
      expect(categoryClassificationSchema.safeParse({ categoryId: ID, necessity }).success).toBe(
        true,
      );
    }
  });

  it("accepts a blank necessity as a way back to unclassified", () => {
    // A user who mis-classified needs a route back to "I haven't decided", and
    // the honest unclassified-share figure depends on that state being reachable.
    expect(categoryClassificationSchema.safeParse({ categoryId: ID, necessity: "" }).success).toBe(
      true,
    );
  });

  it("rejects a necessity outside the CHECK vocabulary", () => {
    expect(
      categoryClassificationSchema.safeParse({ categoryId: ID, necessity: "important" }).success,
    ).toBe(false);
  });

  it("rejects a non-UUID category id", () => {
    expect(categoryClassificationSchema.safeParse({ categoryId: "groceries" }).success).toBe(false);
  });
});

describe("bulkClassifySchema", () => {
  const id = (n: number) => `1111111${n}-1111-4111-8111-111111111111`;

  it("accepts a batch of assignments", () => {
    const parsed = bulkClassifySchema.safeParse({
      assignments: [
        { categoryId: id(1), necessity: "essential" },
        { categoryId: id(2), necessity: "discretionary" },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects the same category twice — which write wins would depend on order", () => {
    const message = messageOf(
      bulkClassifySchema.safeParse({
        assignments: [
          { categoryId: id(1), necessity: "essential" },
          { categoryId: id(1), necessity: "discretionary" },
        ],
      }),
    );

    expect(message).toContain("appears twice");
  });

  it("rejects an empty confirmation", () => {
    expect(messageOf(bulkClassifySchema.safeParse({ assignments: [] }))).toContain("at least one");
  });

  it("bounds the batch size", () => {
    const assignments = Array.from({ length: 201 }, (_, i) => ({
      categoryId: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
      necessity: "essential" as const,
    }));

    expect(messageOf(bulkClassifySchema.safeParse({ assignments }))).toContain("Too many");
  });
});

describe("householdProfileSchema", () => {
  const blank = {
    reserveMonthsOverride: "",
    retirementTargetAge: "",
    benchmarkSavingsApy: "",
    needsPct: "",
    wantsPct: "",
    savingsPct: "",
    highInterestThresholdApr: "",
  };

  it("accepts an entirely blank profile — blank means 'use the default'", () => {
    // Every column is an override of a checked-in constant. Blank is the normal
    // state, not an incomplete one.
    expect(householdProfileSchema.safeParse(blank).success).toBe(true);
  });

  it("accepts a fully specified profile", () => {
    const parsed = householdProfileSchema.safeParse({
      ...blank,
      reserveMonthsOverride: "6",
      retirementTargetAge: "62",
      benchmarkSavingsApy: "4.5",
      needsPct: "60",
      wantsPct: "20",
      savingsPct: "20",
      highInterestThresholdApr: "0.07",
    });

    expect(parsed.success).toBe(true);
  });

  it("requires all three split percentages or none", () => {
    const message = messageOf(
      householdProfileSchema.safeParse({ ...blank, needsPct: "60", wantsPct: "20" }),
    );

    // A partial split has no meaning — the diagnostic compares three shares
    // against a whole.
    expect(message).toContain("all three");
  });

  it("requires the split to add up to 100", () => {
    const message = messageOf(
      householdProfileSchema.safeParse({
        ...blank,
        needsPct: "60",
        wantsPct: "20",
        savingsPct: "10",
      }),
    );

    // 90 would leave a tenth of take-home silently unaccounted for.
    expect(message).toContain("add up to 100");
    expect(message).toContain("90");
  });

  it("tolerates a split that rounds, like 33.33/33.33/33.34", () => {
    expect(
      householdProfileSchema.safeParse({
        ...blank,
        needsPct: "33.33",
        wantsPct: "33.33",
        savingsPct: "33.34",
      }).success,
    ).toBe(true);
  });

  it("rejects a negative share", () => {
    expect(
      householdProfileSchema.safeParse({
        ...blank,
        needsPct: "-10",
        wantsPct: "60",
        savingsPct: "50",
      }).success,
    ).toBe(false);
  });

  it("bounds the reserve-months override to whole months in range", () => {
    expect(householdProfileSchema.safeParse({ ...blank, reserveMonthsOverride: "3" }).success).toBe(
      true,
    );
    expect(householdProfileSchema.safeParse({ ...blank, reserveMonthsOverride: "0" }).success).toBe(
      false,
    );
    expect(
      householdProfileSchema.safeParse({ ...blank, reserveMonthsOverride: "61" }).success,
    ).toBe(false);
    // Half a month of reserve is not a thing.
    expect(
      householdProfileSchema.safeParse({ ...blank, reserveMonthsOverride: "3.5" }).success,
    ).toBe(false);
  });

  it("bounds the retirement target age", () => {
    expect(householdProfileSchema.safeParse({ ...blank, retirementTargetAge: "62" }).success).toBe(
      true,
    );
    expect(householdProfileSchema.safeParse({ ...blank, retirementTargetAge: "20" }).success).toBe(
      false,
    );
  });

  it("keeps the two rate conventions apart", () => {
    // The benchmark APY is a percentage; the high-interest threshold is a
    // fraction. Swapping them is the mistake the messages are written for.
    expect(householdProfileSchema.safeParse({ ...blank, benchmarkSavingsApy: "4.5" }).success).toBe(
      true,
    );
    expect(
      messageOf(householdProfileSchema.safeParse({ ...blank, highInterestThresholdApr: "7" })),
    ).toContain("decimal fraction");
    expect(
      householdProfileSchema.safeParse({ ...blank, highInterestThresholdApr: "0.07" }).success,
    ).toBe(true);
  });
});

describe("householdMemberSchema", () => {
  it("accepts a member with a label alone", () => {
    // Birth year is optional: a household can list its people before deciding
    // how much the app should know about them.
    expect(householdMemberSchema.safeParse({ label: "Me", birthYear: "" }).success).toBe(true);
  });

  it("requires a label", () => {
    expect(messageOf(householdMemberSchema.safeParse({ label: "  " }))).toContain("required");
  });

  it("rejects a birth year in the future", () => {
    // The DB CHECK cannot express this (a CHECK cannot call a non-immutable
    // function), so this is the real guard. A future year makes an age negative
    // and quietly poisons every age-based rule.
    const nextYear = String(new Date().getUTCFullYear() + 1);
    const message = messageOf(
      householdMemberSchema.safeParse({ label: "Me", birthYear: nextYear }),
    );

    expect(message).toContain("this year");
  });

  it("accepts the current year — a newborn is a dependent", () => {
    const thisYear = String(new Date().getUTCFullYear());

    expect(
      householdMemberSchema.safeParse({ label: "Baby", birthYear: thisYear, isDependent: true })
        .success,
    ).toBe(true);
  });

  it("rejects an implausibly early birth year", () => {
    expect(householdMemberSchema.safeParse({ label: "Me", birthYear: "1899" }).success).toBe(false);
    expect(householdMemberSchema.safeParse({ label: "Me", birthYear: "1900" }).success).toBe(true);
  });

  it("rejects a fractional birth year", () => {
    expect(householdMemberSchema.safeParse({ label: "Me", birthYear: "1985.5" }).success).toBe(
      false,
    );
  });
});
