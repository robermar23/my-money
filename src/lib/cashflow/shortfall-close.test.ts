// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ShortfallCloseInput, classifyShortfall } from "./shortfall-close.ts";

/**
 * CF-B2 — the shortfall classification (ADR-048).
 *
 * Four cases, four sentences, and every boundary between them is a place a
 * household reads something different about their own money. The interesting
 * tests here are the ones about what the classifier REFUSES to say: that
 * un-triaged cash is savings, and that a reserve of exactly zero is the same
 * statement as a reserve it cannot see.
 */

function input(over: Partial<ShortfallCloseInput> = {}): ShortfallCloseInput {
  return {
    shortfall: "3030.33",
    reserveTotal: "14400.00",
    reserveAccountCount: 1,
    unclassifiedCount: 0,
    ...over,
  };
}

describe("classifyShortfall — a shortfall the savings covers is a timing problem", () => {
  it("names the transfer and what is left afterwards", () => {
    const result = classifyShortfall(input());

    expect(result.kind).toBe("covered");
    if (result.kind !== "covered") throw new Error("unreachable");
    // Exactly the shortfall — enough to reach the floor, and no more. The page
    // is describing a gap, not recommending a sweep.
    expect(result.transferAmount).toBe("3030.33");
    expect(result.remainingAfterTransfer).toBe("11369.67");
  });

  it("counts a reserve exactly equal to the shortfall as covered", () => {
    // The boundary, drawn the same way safe-to-spend draws its own: landing
    // exactly ON the line is not falling below it. Two surfaces disagreeing
    // about a household sitting on the line is the defect this prevents.
    const result = classifyShortfall(input({ reserveTotal: "3030.33" }));

    expect(result.kind).toBe("covered");
    if (result.kind !== "covered") throw new Error("unreachable");
    expect(result.remainingAfterTransfer).toBe("0.00");
  });

  it("does not lose a cent across the subtraction", () => {
    const result = classifyShortfall(input({ shortfall: "0.01", reserveTotal: "1000.00" }));
    if (result.kind !== "covered") throw new Error("unreachable");
    expect(result.remainingAfterTransfer).toBe("999.99");
  });
});

describe("classifyShortfall — a reserve that helps but does not finish", () => {
  it("reports what is still short, and clamps the remainder at zero", () => {
    const result = classifyShortfall(input({ shortfall: "3030.33", reserveTotal: "1200.00" }));

    expect(result.kind).toBe("partly_covered");
    if (result.kind !== "partly_covered") throw new Error("unreachable");
    expect(result.transferAmount).toBe("1200.00");
    // Never negative: "you would have −$1,830.33 in savings" is not a fact
    // about anything. The size of the unsolved problem lives in `stillShort`.
    expect(result.remainingAfterTransfer).toBe("0.00");
    expect(result.stillShort).toBe("1830.33");
  });

  it("is partly covered by a single cent of reserve, not uncovered", () => {
    const result = classifyShortfall(input({ shortfall: "500.00", reserveTotal: "0.01" }));
    expect(result.kind).toBe("partly_covered");
  });
});

describe("classifyShortfall — a shortfall nothing closes is a solvency problem", () => {
  it("reports uncovered when the reserve accounts are there and empty", () => {
    // Known and zero is a real answer, and a different one from "we cannot
    // tell". The household has a savings account with nothing in it.
    const result = classifyShortfall(input({ reserveTotal: "0.00", reserveAccountCount: 2 }));
    expect(result.kind).toBe("uncovered");
  });

  it("reports uncovered when there is no reserve account and no unclassified cash", () => {
    // Nothing is unknown here either: every cash account has been triaged and
    // none of them is savings.
    const result = classifyShortfall(
      input({ reserveTotal: "0.00", reserveAccountCount: 0, unclassifiedCount: 0 }),
    );
    expect(result.kind).toBe("uncovered");
  });
});

describe("classifyShortfall — un-triaged cash is never counted as savings", () => {
  it("reports reserve_unknown rather than guessing", () => {
    // ADR-033 §1. That account might be savings — and might be a CD, or a
    // second checking account already inside the projection. Counting it would
    // tell a household their shortfall is covered by money that is committed or
    // already spent.
    const result = classifyShortfall(
      input({ reserveTotal: "0.00", reserveAccountCount: 0, unclassifiedCount: 3 }),
    );

    expect(result.kind).toBe("reserve_unknown");
    if (result.kind !== "reserve_unknown") throw new Error("unreachable");
    expect(result.unclassifiedCount).toBe(3);
    // The shortfall itself still travels — the household is still short, and
    // that half of the sentence is not in doubt.
    expect(result.shortfall).toBe("3030.33");
  });

  it("prefers a classified reserve over the unknown branch", () => {
    // Once ONE savings account is classified the app can answer, and the
    // remaining un-triaged accounts do not make it unanswerable again.
    const result = classifyShortfall(input({ unclassifiedCount: 4 }));
    expect(result.kind).toBe("covered");
  });
});

describe("classifyShortfall — nonsense stops the run rather than rendering", () => {
  it("refuses a negative reserve", () => {
    expect(() => classifyShortfall(input({ reserveTotal: "-100.00" }))).toThrow(/negative/);
  });

  it("refuses a negative shortfall", () => {
    expect(() => classifyShortfall(input({ shortfall: "-1.00" }))).toThrow(/magnitude/);
  });

  it("refuses a fractional account count", () => {
    expect(() => classifyShortfall(input({ reserveAccountCount: 1.5 }))).toThrow(/integer/);
  });
});

describe("CF-B2 — the module never converts money to a float", () => {
  it("contains no Number(), parseFloat or parseInt call", () => {
    // A source scan, the same discipline the privacy suite uses, and for a
    // related reason: one float conversion on the way to a comparison is how
    // "your savings covers this" comes to be wrong by a cent — in the direction
    // that tells a household they are fine when they are not.
    const src = readFileSync(join(__dirname, "shortfall-close.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    expect(src).not.toMatch(/\bNumber\s*\(/);
    expect(src).not.toMatch(/\bparse(?:Float|Int)\s*\(/);
    // Every arithmetic operator on a money value has to be a Money method.
    expect(src).not.toMatch(/\btoFixed\b/);
  });
});
