// @vitest-environment node
import { Money } from "@/lib/money/money.ts";
import { describe, expect, it } from "vitest";
import {
  type IncomeSourceInput,
  type ObligationInput,
  expandIncomeEvents,
  expandObligationEvents,
} from "./events.ts";
import { projectDailyBalance } from "./project.ts";
import { residualDailyRate } from "./residual.ts";

/**
 * P16-16 — the no-double-count invariant (ADR-038 §2).
 *
 * **This file exists on its own so it cannot be folded into another suite and
 * forgotten.** It is the regression gate for the one defect that would quietly
 * make safe-to-spend too low: taking a total-spend run-rate AND ALSO putting
 * the mortgage on the calendar, which charges the household for its bills twice
 * and produces a plausible number that is wrong in the direction that destroys
 * trust in the feature.
 *
 * ── The invariant ──────────────────────────────────────────────────────────
 *
 *     projected outflow over a full month
 *       ≤ observed monthly spend + obligations added since the observation window
 *
 * "Added since" is derived from the DATA, not from a label on the fixture:
 * per obligation, `max(0, outflow in the projection window − outflow attributed
 * during observation)`. Deriving it that way generalizes the invariant to every
 * cadence — a quarterly premium that falls in the projected month but not in the
 * observed one is genuinely new outflow, while a weekly bill that falls five
 * times instead of four contributes only the extra week.
 *
 * ── Why it bites ───────────────────────────────────────────────────────────
 * The bound reduces to `observed + Σ max(0, projected_i − attributed_i)`, while
 * a correct implementation spends `observed − Σ attributed_i + Σ projected_i`.
 * A double-counting implementation spends `observed + Σ projected_i`, which
 * exceeds the bound the moment any obligation was attributed at all. There is a
 * test below that builds exactly that implementation by hand and shows the
 * assertion catching it — an invariant nobody has watched fail is a comment.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 * The fixture sweep uses a seeded generator, never `Math.random`. A flaky
 * invariant is worse than no invariant: it gets marked skipped the first time it
 * fails on a Friday.
 */

const CURRENCY = "USD";

/** Both windows are full 31-day calendar months, so "a full month" is literal. */
const OBSERVATION = { from: "2026-01-01", to: "2026-01-31", days: 31 } as const;
const PROJECTION = { from: "2026-03-01", to: "2026-03-31", days: 31 } as const;

/**
 * A small deterministic LCG (Numerical Recipes constants). Seeded per case so a
 * failure names the exact fixture that produced it and reruns identically.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

const CADENCES = ["weekly", "biweekly", "semimonthly", "monthly", "quarterly", "annual"] as const;

function generateObligations(seed: number, count: number): ObligationInput[] {
  const rand = lcg(seed);
  const obligations: ObligationInput[] = [];

  for (let i = 0; i < count; i += 1) {
    const cadence = CADENCES[Math.floor(rand() * CADENCES.length)] ?? "monthly";
    // Anchors are spread across a whole year so quarterly and annual schedules
    // land inside, outside, or across both windows.
    const month = 1 + Math.floor(rand() * 12);
    const day = 1 + Math.floor(rand() * 28);
    const cents = 500 + Math.floor(rand() * 400_000);

    obligations.push({
      id: `ob-${seed}-${i}`,
      label: `Obligation ${i}`,
      expectedAmount: Money.fromString(String(cents), CURRENCY).div(100).toString(),
      direction: "outflow",
      amountMode: "fixed",
      cadence,
      anchorDate: `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      startDate: "2020-01-01",
      endDate: null,
      active: true,
    });
  }

  return obligations;
}

/** Collapse to storable cents. Real money is NUMERIC(18,2); fixtures must be too. */
function toCents(value: Money): Money {
  return Money.fromString(value.toString(), CURRENCY);
}

/** Total outflow of one obligation inside a window, via the tested expander. */
function outflowInWindow(obligation: ObligationInput, from: string, to: string): Money {
  return Money.sum(
    expandObligationEvents([obligation], from, to)
      .filter((e) => e.direction === "outflow")
      .map((e) => Money.fromString(e.amount, CURRENCY)),
    CURRENCY,
  );
}

interface InvariantCase {
  readonly projectedOutflow: Money;
  readonly bound: Money;
  readonly observed: Money;
  readonly attributed: Money;
}

/**
 * Run one household through observation → residual → projection and return the
 * two figures the invariant compares.
 *
 * `attributedShare` models how much of the observation window's obligation
 * outflow the matcher actually accounted for: 1 is perfect matching, 0 is a
 * household with no confirmed obligations yet, and values between are the real
 * world (ADR-038's stated limitation — the subtraction is only as exact as the
 * matching).
 */
function runCase(
  obligations: readonly ObligationInput[],
  observedExpense: string,
  attributedShare: string,
): InvariantCase {
  const observed = Money.fromString(observedExpense, CURRENCY);

  // Rounded to cents on the way out: every money value in this app is
  // NUMERIC(18,2), and a fixture that produced half-cents would be testing an
  // artifact of the harness rather than the arithmetic under test.
  const attributedPerObligation = obligations.map((o) =>
    toCents(outflowInWindow(o, OBSERVATION.from, OBSERVATION.to).mul(attributedShare)),
  );
  const attributed = Money.sum(attributedPerObligation, CURRENCY);

  // The matcher can never attribute more than the household actually spent.
  const cappedAttributed = attributed.compare(observed) > 0 ? observed : attributed;

  const residual = residualDailyRate(
    observed.toString(),
    cappedAttributed.toString(),
    OBSERVATION.days,
  );

  const projection = projectDailyBalance({
    from: PROJECTION.from,
    to: PROJECTION.to,
    openingBalance: "10000.00",
    events: expandObligationEvents(obligations, PROJECTION.from, PROJECTION.to),
    residual,
    cashFloor: "0.00",
    status: "ok",
    inputsUsed: [],
  });

  const projectedOutflow = Money.sum(
    projection.points.map((p) => Money.fromString(p.outflow, CURRENCY)),
    CURRENCY,
  );

  // "Obligations added since the observation window", per obligation, clamped at
  // zero so a schedule that shrank does not buy headroom for one that grew.
  const scale = cappedAttributed.compare(attributed) === 0 ? "1" : null;
  const addedSince = Money.sum(
    obligations.map((o, i) => {
      const projected = outflowInWindow(o, PROJECTION.from, PROJECTION.to);
      const observedShare =
        scale === null
          ? Money.zero(CURRENCY) // attribution was capped; claim nothing
          : (attributedPerObligation[i] ?? Money.zero(CURRENCY));
      const delta = projected.sub(observedShare);
      return delta.isNegative() ? Money.zero(CURRENCY) : delta;
    }),
    CURRENCY,
  );

  return {
    projectedOutflow,
    bound: observed.add(addedSince),
    observed,
    attributed: cappedAttributed,
  };
}

describe("no-double-count invariant (ADR-038 §2)", () => {
  it("holds for a plain household: one mortgage, one subscription, perfect matching", () => {
    const obligations: ObligationInput[] = [
      {
        id: "ob-mortgage",
        label: "Mortgage",
        expectedAmount: "2150.00",
        direction: "outflow",
        amountMode: "fixed",
        cadence: "monthly",
        anchorDate: "2026-01-01",
        startDate: "2020-01-01",
        endDate: null,
        active: true,
      },
      {
        id: "ob-netflix",
        label: "Netflix",
        expectedAmount: "22.99",
        direction: "outflow",
        amountMode: "fixed",
        cadence: "monthly",
        anchorDate: "2026-01-15",
        startDate: "2020-01-01",
        endDate: null,
        active: true,
      },
    ];

    const result = runCase(obligations, "4500.00", "1");

    // Attribution is exact and both windows hold the same schedule, so the
    // projection spends precisely what the household was observed to spend.
    expect(result.attributed.toString()).toBe("2172.99");
    expect(result.projectedOutflow.compare(result.bound)).toBeLessThanOrEqual(0);
    expect(result.bound.toString()).toBe("4500.00");
  });

  it("holds across a generated sweep of households, cadences and match quality", () => {
    const shares = ["0.00", "0.25", "0.50", "0.75", "1.00"];
    let checked = 0;

    for (let seed = 1; seed <= 40; seed += 1) {
      const obligations = generateObligations(seed, 1 + (seed % 6));
      for (const spend of ["1200.00", "4500.00", "9875.43"]) {
        for (const share of shares) {
          const result = runCase(obligations, spend, share);

          expect(
            result.projectedOutflow.compare(result.bound),
            `seed ${seed}, spend ${spend}, share ${share}: projected ${result.projectedOutflow.toString()} > bound ${result.bound.toString()}`,
          ).toBeLessThanOrEqual(0);
          checked += 1;
        }
      }
    }

    expect(checked).toBe(600);
  });

  it("holds when the household has no confirmed obligations at all", () => {
    // The pure run-rate case: nothing is attributed, so nothing is subtracted,
    // and the projection must still not exceed observed spend.
    const result = runCase([], "3100.00", "1");

    expect(result.projectedOutflow.compare(result.bound)).toBeLessThanOrEqual(0);
    expect(result.attributed.toString()).toBe("0.00");
  });

  it("holds when matching over-attributes", () => {
    const obligations = generateObligations(7, 4);
    // A tiny observed total against real obligations forces the clamp.
    const result = runCase(obligations, "50.00", "1.00");

    expect(result.projectedOutflow.compare(result.bound)).toBeLessThanOrEqual(0);
  });

  it("CATCHES a double-counting projection — the invariant is not vacuous", () => {
    // Build the defect by hand: spread the FULL observed spend as the daily
    // rate (no subtraction) and still put every obligation on the calendar.
    const obligations: ObligationInput[] = [
      {
        id: "ob-mortgage",
        label: "Mortgage",
        expectedAmount: "2150.00",
        direction: "outflow",
        amountMode: "fixed",
        cadence: "monthly",
        anchorDate: "2026-01-01",
        startDate: "2020-01-01",
        endDate: null,
        active: true,
      },
    ];
    const observed = Money.fromString("4500.00", CURRENCY);

    const doubleCounted = projectDailyBalance({
      from: PROJECTION.from,
      to: PROJECTION.to,
      openingBalance: "10000.00",
      events: expandObligationEvents(obligations, PROJECTION.from, PROJECTION.to),
      // The bug: the rate is built from total spend with nothing subtracted.
      residual: residualDailyRate(observed.toString(), "0.00", OBSERVATION.days),
      cashFloor: "0.00",
      status: "ok",
      inputsUsed: [],
    });

    const projectedOutflow = Money.sum(
      doubleCounted.points.map((p) => Money.fromString(p.outflow, CURRENCY)),
      CURRENCY,
    );
    const correct = runCase(obligations, "4500.00", "1");

    // It spends the mortgage twice: once inside the rate, once on the 1st.
    expect(projectedOutflow.compare(correct.bound)).toBeGreaterThan(0);

    // The excess IS the mortgage, to within the rate's cent truncation: the two
    // rates are each floored to cents, so 31 days of them can differ from the
    // exact figure by up to a cent a day. Asserting an exact $2,150.00 would be
    // asserting something that is not true, which is worse than a stated bound.
    const excess = projectedOutflow.sub(correct.projectedOutflow);
    const mortgage = Money.fromString("2150.00", CURRENCY);
    expect(
      excess.sub(mortgage).abs().compare(Money.fromString("0.31", CURRENCY)),
    ).toBeLessThanOrEqual(0);
  });
});

/* ── CF-C2: confirming a stated loan schedule RE-DATES, it never adds ─────── */

describe("CF-C2 — a liability-sourced obligation moves spend rather than adding it", () => {
  /**
   * PLAN_CASHFLOW_GAPS §1's central claim, asserted (ADR-047).
   *
   * The mortgage was never missing from the projection. Unconfirmed, it is a
   * transaction like any other: inside trailing observed spend, therefore inside
   * the residual daily rate, therefore spread flat across every day of the
   * horizon. What was wrong is that $2,150 which actually leaves on the 1st was
   * being charged at ~$70/day for a month — so the low-water DATE was wrong,
   * and the low-water date is the entire product of `/plan/cashflow`.
   *
   * Confirming the candidate must therefore leave the TOTAL untouched and move
   * only the timing. Provenance never reaches these pure modules — a liability
   * obligation is an `ObligationInput` like any other — and that is precisely
   * what makes the guarantee structural rather than a rule someone remembers:
   * the double-count is prevented by leaving `detection_key` NULL so the
   * occurrence MATCHES (asserted end-to-end in liability-obligations.test.ts),
   * which is what puts the payment into `attributed` here.
   */

  const MORTGAGE: ObligationInput = {
    id: "ob-liability-mortgage",
    label: "Sunwest Mortgage",
    expectedAmount: "2150.00",
    direction: "outflow",
    // The mode a confirmed liability candidate carries once payments are seen.
    amountMode: "trailing_median",
    cadence: "monthly",
    anchorDate: "2026-01-01",
    startDate: "2020-01-01",
    endDate: null,
    active: true,
  };

  /** Total observed household spend in the observation month, mortgage included. */
  const OBSERVED = "4500.00";

  /** Project a month, given how much of the observed spend was attributed. */
  function project(attributed: string, events: readonly ObligationInput[]) {
    return projectDailyBalance({
      from: PROJECTION.from,
      to: PROJECTION.to,
      openingBalance: "3000.00",
      events: expandObligationEvents(events, PROJECTION.from, PROJECTION.to),
      residual: residualDailyRate(OBSERVED, attributed, OBSERVATION.days),
      cashFloor: "0.00",
      status: "ok",
      inputsUsed: [],
    });
  }

  /** Before: nothing is dated, and the mortgage hides inside the flat rate. */
  const before = project("0.00", []);
  /** After: the occurrence matches, so the mortgage leaves the rate and is dated. */
  const after = project("2150.00", [MORTGAGE]);

  function totalOutflow(result: ReturnType<typeof project>): Money {
    return Money.sum(
      result.points.map((point) => Money.fromString(point.outflow, CURRENCY)),
      CURRENCY,
    );
  }

  it("does not change total projected outflow over the horizon", () => {
    // The cent-level bound is the rate's truncation, not slack in the claim:
    // both rates are floored to cents, so 31 days of them can differ from the
    // exact figure by up to a cent a day. Asserting an exact equality would be
    // asserting something that is not true, which is worse than a stated bound.
    const drift = totalOutflow(after).sub(totalOutflow(before)).abs();
    expect(drift.compare(Money.fromString("0.31", CURRENCY))).toBeLessThanOrEqual(0);
  });

  it("puts a cliff on the payment day that was not there before", () => {
    // The whole point of confirming. Before, every day looks the same; after,
    // one day carries the mortgage.
    const rate = Money.fromString(
      residualDailyRate(OBSERVED, "2150.00", OBSERVATION.days).dailyRate,
      CURRENCY,
    );
    const first = after.points.find((point) => point.date === "2026-03-01");
    expect(first).toBeDefined();

    const dated = Money.fromString(first?.outflow ?? "0.00", CURRENCY).sub(rate);
    expect(dated.toString()).toBe("2150.00");

    // And no day of the un-confirmed projection carries anything but the rate.
    for (const point of before.points) {
      expect(point.outflow).toBe(residualDailyRate(OBSERVED, "0.00", OBSERVATION.days).dailyRate);
    }
  });

  it("moves the low-water DATE, which is the defect being fixed", () => {
    // The claim in one assertion. A household with no inflows has a
    // monotonically falling line, so its low point is always the last day and
    // the date can never move — which is exactly why this case adds paychecks.
    // With income on the 1st and the 16th, the binding day is the one just
    // before a payday, and where that lands depends entirely on WHEN the
    // mortgage is charged.
    const payroll: IncomeSourceInput = {
      id: "inc-1",
      name: "Paycheck",
      cadence: "semimonthly",
      anchorDate: "2026-03-01",
      startDate: "2020-01-01",
      endDate: null,
      active: true,
    };
    const paychecks = expandIncomeEvents(
      [payroll],
      new Map([["inc-1", "2500.00"]]),
      PROJECTION.from,
      PROJECTION.to,
    );
    // Late in the month, so the two schedules genuinely bind on different days.
    const lateMortgage: ObligationInput = { ...MORTGAGE, anchorDate: "2026-01-25" };

    function withIncome(attributed: string, events: readonly ObligationInput[]) {
      return projectDailyBalance({
        from: PROJECTION.from,
        to: PROJECTION.to,
        openingBalance: "3000.00",
        events: [...expandObligationEvents(events, PROJECTION.from, PROJECTION.to), ...paychecks],
        residual: residualDailyRate(OBSERVED, attributed, OBSERVATION.days),
        cashFloor: "0.00",
        status: "ok",
        inputsUsed: [],
      });
    }

    const smeared = withIncome("0.00", []);
    const dated = withIncome("2150.00", [lateMortgage]);

    // Same total, different binding day — and the day is what a family plans
    // around. This is the whole complaint, reduced to one inequality.
    expect(dated.lowWaterMark?.date).not.toBe(smeared.lowWaterMark?.date);

    const drift = Money.sum(
      dated.points.map((point) => Money.fromString(point.outflow, CURRENCY)),
      CURRENCY,
    )
      .sub(
        Money.sum(
          smeared.points.map((point) => Money.fromString(point.outflow, CURRENCY)),
          CURRENCY,
        ),
      )
      .abs();
    expect(drift.compare(Money.fromString("0.31", CURRENCY))).toBeLessThanOrEqual(0);
  });

  it("CATCHES the double-count if the occurrence never matches", () => {
    // The failure ADR-047 §4 exists to prevent, built by hand: a synthetic
    // `detection_key` means the matcher pairs nothing, so `attributed` stays
    // zero — the mortgage is left inside the flat rate AND dated on the 1st.
    const doubleCounted = project("0.00", [MORTGAGE]);
    const excess = totalOutflow(doubleCounted).sub(totalOutflow(before));

    expect(
      excess
        .sub(Money.fromString("2150.00", CURRENCY))
        .abs()
        .compare(Money.fromString("0.31", CURRENCY)),
    ).toBeLessThanOrEqual(0);
  });
});
