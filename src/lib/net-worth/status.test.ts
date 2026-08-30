// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type AttributionStatusInput, attributionStatus } from "./status.ts";

/**
 * P17-14 — the degradation ladder.
 *
 * Each level gets a case, and the last block pins the property the plan asks
 * for explicitly: `ok` is unreachable while either endpoint is unserved by a
 * snapshot. That is the assertion that keeps a fabricated gain off the page.
 */

const WINDOW = { from: "2026-01-01", to: "2026-03-31" } as const;

function input(overrides: Partial<AttributionStatusInput> = {}): AttributionStatusInput {
  return { ...WINDOW, firstSnapshotDate: "2020-01-01", ...overrides };
}

describe("no_snapshots", () => {
  it("fires on a book that has never recorded a balance", () => {
    const result = attributionStatus(input({ firstSnapshotDate: null }));
    expect(result.status).toBe("no_snapshots");
    expect(result.missing?.label).toBe("Recorded account balances");
    // `null`, not "0" — the household may have the money; the app was never told.
    expect(result.missing?.value).toBeNull();
    expect(result.missing?.missing).toBe(true);
    expect(result.missing?.href).toBe("/accounts");
  });

  it("fires when every balance was recorded after the window ended", () => {
    const result = attributionStatus(input({ firstSnapshotDate: "2026-06-01" }));
    expect(result.status).toBe("no_snapshots");
    expect(result.missing?.source).toContain("2026-06-01");
  });

  it("does not fire when the first record lands exactly on the closing endpoint", () => {
    // On `to` itself there IS a closing figure, so a decomposition can be
    // stated — against an empty opening book, which is the next rung down.
    expect(attributionStatus(input({ firstSnapshotDate: WINDOW.to })).status).toBe(
      "insufficient_history",
    );
  });
});

describe("insufficient_history", () => {
  it("fires when the book begins inside the window", () => {
    const result = attributionStatus(input({ firstSnapshotDate: "2026-02-15" }));
    expect(result.status).toBe("insufficient_history");
    expect(result.missing?.value).toBe("2026-02-15");
    expect(result.missing?.source).toContain("2026-02-15");
    expect(result.missing?.href).toBe("/accounts");
  });

  it("does not fire when the book begins exactly on the opening endpoint", () => {
    expect(attributionStatus(input({ firstSnapshotDate: WINDOW.from })).status).toBe("ok");
  });
});

describe("ok", () => {
  it("is reached when records predate the window", () => {
    const result = attributionStatus(input());
    expect(result.status).toBe("ok");
    expect(result.missing).toBeNull();
  });

  it("is unreachable while either endpoint is unserved", () => {
    // The property the plan names. Sweep every date relationship rather than
    // asserting the three cases individually, so a future edit that reorders
    // the ladder cannot leave a gap between two rungs.
    const dates = [null, "2019-01-01", "2026-01-01", "2026-01-02", "2026-03-31", "2026-04-01"];
    for (const firstSnapshotDate of dates) {
      const result = attributionStatus(input({ firstSnapshotDate }));
      const servesOpening = firstSnapshotDate !== null && firstSnapshotDate <= WINDOW.from;
      expect(result.status === "ok", `first=${firstSnapshotDate}`).toBe(servesOpening);
      expect(result.missing === null, `first=${firstSnapshotDate} missing`).toBe(servesOpening);
    }
  });
});

describe("guards", () => {
  it("throws on a backwards window instead of degrading into a plausible screen", () => {
    expect(() => attributionStatus(input({ from: "2026-03-31", to: "2026-01-01" }))).toThrow(
      /backwards/,
    );
  });

  it("accepts a single-day window", () => {
    expect(
      attributionStatus({ from: "2026-01-01", to: "2026-01-01", firstSnapshotDate: "2025-01-01" })
        .status,
    ).toBe("ok");
  });
});
