// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import type {
  AttributionResult,
  AttributionRung,
  AttributionRungId,
} from "@/lib/net-worth/types.ts";
import { ATTRIBUTION_RUNG_IDS } from "@/lib/net-worth/types.ts";
import { describe, expect, it } from "vitest";
import {
  STATED_ATTRIBUTION_STATUSES,
  attributionNotice,
  longDate,
  waterfallBars,
} from "./view-models.ts";

/**
 * P17-20/21/22 — the delivery surface's pure half.
 *
 * The geometry is the part worth pinning. A waterfall whose bars do not chain
 * is not a cosmetic defect: it is the app drawing a picture that contradicts
 * the identity its own tests prove holds exactly. So the assertions here are
 * about *edges meeting*, and about the two cases where a plausible-looking
 * implementation quietly breaks — a running total that crosses zero, and a rung
 * whose amount is zero.
 */

const CURRENCY = "USD";

const LABELS: Readonly<Record<AttributionRungId, string>> = {
  saved: "Saved from income",
  retirement: "Retirement contributions",
  debt_principal: "Loan principal paid",
  investment_return: "Investment return",
  asset_revaluation: "Property & asset revaluation",
  unexplained: "Not yet explained",
};

/** Identity-consistent by construction: `closing` is `opening + Σ rungs`. */
function result(
  amounts: Partial<Record<AttributionRungId, string>>,
  opening = "100000.00",
  overrides: Partial<AttributionResult> = {},
): AttributionResult {
  const rungs: AttributionRung[] = ATTRIBUTION_RUNG_IDS.map((id) => ({
    id,
    label: LABELS[id],
    amount: amounts[id] ?? "0.00",
    inputsUsed: [],
  }));
  const open = Money.fromString(opening, CURRENCY);
  const delta = Money.sum(
    rungs.map((r) => Money.fromString(r.amount, CURRENCY)),
    CURRENCY,
  );
  return {
    from: "2026-01-01",
    to: "2026-03-31",
    opening: open.toString(),
    closing: open.add(delta).toString(),
    delta: delta.toString(),
    rungs,
    diagnostics: [],
    status: "ok",
    inputsUsed: [],
    ...overrides,
  };
}

/** The page passes `Money.format`; tests pass identity so assertions stay exact. */
const raw = (amount: string): string => amount;

describe("waterfall geometry", () => {
  const input = result({
    saved: "2500.00",
    retirement: "1000.00",
    debt_principal: "894.22",
    investment_return: "-3200.00",
    asset_revaluation: "10000.00",
    unexplained: "-194.22",
  });
  const bars = waterfallBars(input, raw, CURRENCY);

  it("emits an anchor, six rungs, and an anchor", () => {
    expect(bars.map((b) => b.key)).toEqual(["opening", ...ATTRIBUTION_RUNG_IDS, "closing"]);
  });

  it("chains every rung bar to the one before it, with no gaps", () => {
    // The bars physically touch. If this ever fails, the identity that
    // `decompose.invariant.test.ts` proves has stopped holding — or someone
    // introduced a float into the walk.
    for (let i = 1; i < bars.length - 1; i += 1) {
      const previousEnd = i === 1 ? bars[0]?.end : bars[i - 1]?.end;
      expect(bars[i]?.start).toBe(previousEnd);
    }
  });

  it("lands the closing anchor exactly on the reported closing net worth", () => {
    expect(bars.at(-1)?.end).toBe(input.closing);
  });

  it("draws both anchors from zero, because they are totals rather than moves", () => {
    expect(bars[0]?.start).toBe("0.00");
    expect(bars[0]?.end).toBe(input.opening);
    expect(bars.at(-1)?.start).toBe("0.00");
  });

  it("shows each rung's own signed amount, not its bar height", () => {
    const market = bars.find((b) => b.key === "investment_return");
    expect(market?.amountDisplay).toBe("-3200.00");
    // …and the bar itself runs downward, start above end.
    expect(
      Money.fromString(market?.start ?? "0", CURRENCY).compare(
        Money.fromString(market?.end ?? "0", CURRENCY),
      ),
    ).toBe(1);
  });
});

describe("bar tone", () => {
  const bars = waterfallBars(
    result({ saved: "-500.00", investment_return: "500.00", unexplained: "0.00" }),
    raw,
    CURRENCY,
  );
  const tone = (key: string): string | undefined => bars.find((b) => b.key === key)?.tone;

  it("colours a rung that lost money as a loss", () => {
    expect(tone("saved")).toBe("down");
  });

  it("colours a rung that gained as a gain", () => {
    expect(tone("investment_return")).toBe("up");
  });

  it("never colours the residual as either, even at zero", () => {
    expect(tone("unexplained")).toBe("unknown");
  });

  it("still calls the residual unknown when it is a large positive number", () => {
    const positive = waterfallBars(result({ unexplained: "40000.00" }), raw, CURRENCY);
    expect(positive.find((b) => b.key === "unexplained")?.tone).toBe("unknown");
  });

  it("marks the anchors as anchors rather than as gains", () => {
    expect(tone("opening")).toBe("anchor");
    expect(tone("closing")).toBe("anchor");
  });
});

describe("a decomposition whose identity does NOT hold", () => {
  // Never produced by `decomposeNetWorth` — its residual closes the identity by
  // construction. Hand-built here because the closing anchor's whole job is to
  // be the walk's own endpoint: a future assembler that stopped reconciling must
  // draw a bar that MISSES the axis, visibly, rather than have the chart quietly
  // correct it into a picture that agrees with a total nobody can check.
  const broken = result({ saved: "1000.00" }, "100000.00", { closing: "999999.99" });
  const bars = waterfallBars(broken, raw, CURRENCY);

  it("plots the closing anchor where the rungs actually land, not where the result claims", () => {
    expect(bars.at(-1)?.end).toBe("101000.00");
    expect(bars.at(-1)?.end).not.toBe(broken.closing);
  });
});

describe("a household whose net worth is negative", () => {
  // A mortgage larger than everything else owned — a real state for this app,
  // and the one the stacked-transparent-base waterfall would have drawn wrong.
  const bars = waterfallBars(
    result({ saved: "3000.00", debt_principal: "894.22" }, "-250000.00"),
    raw,
    CURRENCY,
  );

  it("walks below zero without inverting or clamping any bar", () => {
    expect(bars[0]?.end).toBe("-250000.00");
    expect(bars.find((b) => b.key === "saved")?.start).toBe("-250000.00");
    expect(bars.find((b) => b.key === "saved")?.end).toBe("-247000.00");
    expect(bars.at(-1)?.end).toBe("-246105.78");
  });
});

describe("a rung that is exactly zero", () => {
  const bars = waterfallBars(result({ saved: "1000.00" }), raw, CURRENCY);

  it("still gets a bar, so 'we checked' stays distinct from 'we did not look'", () => {
    const retirement = bars.find((b) => b.key === "retirement");
    expect(retirement).toBeDefined();
    expect(retirement?.start).toBe(retirement?.end);
    expect(retirement?.amountDisplay).toBe("0.00");
  });
});

describe("the degradation notice", () => {
  it("blocks the page when nothing has ever been recorded", () => {
    const notice = attributionNotice("no_snapshots", "2026-01-01");
    expect(notice?.tone).toBe("blocking");
    expect(notice?.href).toBe("/accounts");
  });

  it("degrades rather than blocks when only the opening endpoint is unserved", () => {
    // The arithmetic is still right; the OPENING is what is wrong. Hiding the
    // page a user came to specifically to ask a question would be worse than
    // showing it with the reason named.
    const notice = attributionNotice("insufficient_history", "2026-01-01");
    expect(notice?.tone).toBe("degraded");
    expect(notice?.body).toContain("January 1, 2026");
  });

  it("says nothing at all when nothing needs qualifying", () => {
    expect(attributionNotice("ok", "2026-01-01")).toBeNull();
  });

  it("only blocks on the status that has no closing figure", () => {
    // Pinned as a property rather than three examples: a new status must be
    // classified deliberately, and the default here is to render.
    const blocking = (["ok", "insufficient_history", "no_snapshots"] as const).filter(
      (s) => attributionNotice(s, "2026-01-01")?.tone === "blocking",
    );
    expect(blocking).toEqual(["no_snapshots"]);
  });

  it("lets every non-blocking status state a figure", () => {
    expect([...STATED_ATTRIBUTION_STATUSES]).toEqual(["ok", "insufficient_history"]);
  });
});

describe("date formatting", () => {
  it("reads a stored date in UTC, so it never shifts a day", () => {
    expect(longDate("2026-01-01")).toBe("January 1, 2026");
    expect(longDate("2026-12-31")).toBe("December 31, 2026");
  });
});
