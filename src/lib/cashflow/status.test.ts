// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MIN_HISTORY_MONTHS, type StatusInput, projectionStatus } from "./status.ts";

/**
 * P16-19 — the four-level degradation ladder (ADR-038 §7).
 *
 * Degrading honestly is a first-class outcome here, not an error path. On a
 * fresh install three of the four levels are the NORMAL answer, and each one
 * has to name the input it is missing and link to where the user supplies it —
 * the standard P15-37 set and ADR-032's auditability contract.
 */

function input(over: Partial<StatusInput> = {}): StatusInput {
  return {
    operatingAccountCount: 2,
    historyMonths: 12,
    confirmedObligationCount: 5,
    candidateCount: 0,
    ...over,
  };
}

describe("projectionStatus", () => {
  it("reports ok when every required input is present", () => {
    const result = projectionStatus(input());

    expect(result.status).toBe("ok");
    expect(result.missing).toBeNull();
  });

  it("reports no_operating_account, and names it, when no account is classified", () => {
    // Savings and brokerage must never stand in for the account the bills hit
    // (ADR-038 §6) — so there is NO projection at all, not a projection from
    // the wrong money.
    const result = projectionStatus(input({ operatingAccountCount: 0 }));

    expect(result.status).toBe("no_operating_account");
    expect(result.missing).toMatchObject({ missing: true, value: null });
    expect(result.missing?.href).toBe("/accounts");
    expect(result.missing?.label).toMatch(/checking|operating/i);
  });

  it("reports insufficient_history under three months", () => {
    const result = projectionStatus(input({ historyMonths: 2 }));

    expect(result.status).toBe("insufficient_history");
    // Import lives under an account (`/accounts/[id]/import`), so the honest
    // starting point is the account list, not a route that does not exist.
    expect(result.missing?.href).toBe("/accounts");
    expect(result.missing?.value).toBe("2");
  });

  it("treats exactly three months as enough", () => {
    // The boundary is stated, not implied. Two months is a guess wearing a
    // decimal point; three is the shipped threshold (ADR-021's precedent).
    expect(projectionStatus(input({ historyMonths: MIN_HISTORY_MONTHS })).status).toBe("ok");
    expect(projectionStatus(input({ historyMonths: MIN_HISTORY_MONTHS - 1 })).status).toBe(
      "insufficient_history",
    );
  });

  it("reports run_rate_only when there are no confirmed obligations", () => {
    const result = projectionStatus(input({ confirmedObligationCount: 0 }));

    expect(result.status).toBe("run_rate_only");
    expect(result.missing?.href).toBe("/plan/cashflow/review");
  });

  it("points a run_rate_only household at its waiting candidates, with the count", () => {
    // "Label it, and offer the fix" — the fix is the review page, and the count
    // is what makes it worth clicking.
    const result = projectionStatus(input({ confirmedObligationCount: 0, candidateCount: 7 }));

    expect(result.missing?.value).toBe("7");
    expect(result.missing?.source).toMatch(/7/);
  });

  it("still says run_rate_only when detection has found nothing either", () => {
    const result = projectionStatus(input({ confirmedObligationCount: 0, candidateCount: 0 }));

    expect(result.status).toBe("run_rate_only");
    expect(result.missing?.value).toBe("0");
  });

  it("orders the ladder: the most fundamental missing input wins", () => {
    // A household with no operating account ALSO has no history and no
    // obligations. Reporting the obligation gap would send them to a review
    // page that cannot help them yet.
    const destitute = projectionStatus({
      operatingAccountCount: 0,
      historyMonths: 0,
      confirmedObligationCount: 0,
      candidateCount: 0,
    });
    expect(destitute.status).toBe("no_operating_account");

    const young = projectionStatus(input({ historyMonths: 1, confirmedObligationCount: 0 }));
    expect(young.status).toBe("insufficient_history");
  });

  it("cannot reach ok while any required input is absent", () => {
    // The property the plan asks for, swept over the corners.
    for (const accounts of [0, 1]) {
      for (const months of [0, 1, 2, 3, 12]) {
        for (const obligations of [0, 1, 9]) {
          const result = projectionStatus({
            operatingAccountCount: accounts,
            historyMonths: months,
            confirmedObligationCount: obligations,
            candidateCount: 0,
          });
          const complete = accounts > 0 && months >= MIN_HISTORY_MONTHS && obligations > 0;

          expect(result.status === "ok", `${accounts}/${months}/${obligations}`).toBe(complete);
          expect(result.missing === null).toBe(complete);
        }
      }
    }
  });

  it("always names a missing input when it is not ok", () => {
    for (const over of [
      { operatingAccountCount: 0 },
      { historyMonths: 0 },
      { confirmedObligationCount: 0 },
    ]) {
      const result = projectionStatus(input(over));
      expect(result.missing).not.toBeNull();
      expect(result.missing?.missing).toBe(true);
      expect(result.missing?.href).toBeTruthy();
      expect(result.missing?.label.length).toBeGreaterThan(0);
      expect(result.missing?.source.length).toBeGreaterThan(0);
    }
  });

  it("refuses negative counts rather than degrading on nonsense", () => {
    expect(() => projectionStatus(input({ operatingAccountCount: -1 }))).toThrow(/negative/i);
    expect(() => projectionStatus(input({ historyMonths: -3 }))).toThrow(/negative/i);
  });
});
