// @vitest-environment node
import {
  CASHFLOW_ALERT_TYPES,
  CASHFLOW_SWEPT_ALERT_TYPES,
  RULE_ALERT_TYPES,
} from "@/lib/alerts/rules.ts";
import { describe, expect, it } from "vitest";
import {
  AMOUNT_CHANGE_THRESHOLD,
  type AmountChangeInput,
  type MissedOccurrenceInput,
  type ShortfallInput,
  cashFlowAlerts,
  obligationAmountChangedAlerts,
  obligationMissedAlerts,
  projectedShortfallAlerts,
} from "./alerts.ts";

/**
 * P16-28 — the three cash-flow alert types, as executable expectations.
 *
 * Same shape as [advice/alerts.test.ts](../advice/alerts.test.ts): a pure map
 * from an already-computed result to `alerts` rows, so every judgement about
 * what deserves an interruption is testable without Redis, Postgres, or a clock.
 *
 * Two properties get more attention than the happy paths, because both are ways
 * this feature quietly becomes worthless:
 *
 *   - **A standing condition must not re-nag** (ADR-026). A household that is
 *     projected short in March is projected short again tomorrow, and an alert
 *     every night is how you teach someone to ignore the alerts page.
 *   - **No figure reaches `title`** (ADR-015). Every amount lives in `detail`,
 *     which is rendered only in the authenticated UI and never emailed.
 */

const SHORTFALL: ShortfallInput = {
  status: "ok",
  horizonDays: 60,
  coverage: "0.8200",
  lowWaterMark: { date: "2026-03-14", balance: "312.00" },
  safeToSpend: {
    amount: "0.00",
    bindingDate: "2026-03-14",
    floor: "1000.00",
    clampedAtZero: true,
    shortfall: "688.00",
  },
};

function shortfall(over: Partial<ShortfallInput> = {}): ShortfallInput {
  return { ...SHORTFALL, ...over };
}

function missed(over: Partial<MissedOccurrenceInput> = {}): MissedOccurrenceInput {
  return {
    occurrenceId: "occ-1",
    obligationId: "ob-1",
    label: "Mortgage",
    dueDate: "2026-03-01",
    expectedAmount: "2150.00",
    direction: "outflow",
    ...over,
  };
}

function changed(over: Partial<AmountChangeInput> = {}): AmountChangeInput {
  return {
    occurrenceId: "occ-1",
    obligationId: "ob-1",
    label: "Mortgage",
    dueDate: "2026-03-01",
    expectedAmount: "2150.00",
    matchedAmount: "-2400.00",
    amountDelta: "250.00",
    amountMode: "fixed",
    ...over,
  };
}

/* ── Ownership: which job sweeps which type ──────────────────────────────── */

describe("alert-type ownership", () => {
  it("names all three Phase-16 types", () => {
    expect([...CASHFLOW_ALERT_TYPES].sort()).toEqual([
      "obligation_amount_changed",
      "obligation_missed",
      "projected_shortfall",
    ]);
  });

  it("sweeps only the standing condition, not the one-shot events", () => {
    expect(CASHFLOW_SWEPT_ALERT_TYPES).toEqual(["projected_shortfall"]);
  });

  it("does not overlap the anomaly detector's swept set", () => {
    // The whole reason the sets are separate. `detect-anomalies-daily` resolves
    // every open alert of every type it sweeps that it did NOT re-detect this
    // run — so a type it never detects but does sweep would be resolved the
    // same night it fired, before anyone read it.
    for (const type of CASHFLOW_SWEPT_ALERT_TYPES) {
      expect(RULE_ALERT_TYPES).not.toContain(type);
    }
  });
});

/* ── projected_shortfall: the standing condition ─────────────────────────── */

describe("projectedShortfallAlerts", () => {
  it("fires when the projection dips below the household's floor", () => {
    const [alert] = projectedShortfallAlerts(shortfall());
    expect(alert?.type).toBe("projected_shortfall");
    expect(alert?.severity).toBe("warning");
    expect(alert?.detail.shortfall).toBe("688.00");
    expect(alert?.detail.lowWaterDate).toBe("2026-03-14");
  });

  it("is silent when safe-to-spend is a real allowance", () => {
    expect(
      projectedShortfallAlerts(
        shortfall({
          safeToSpend: {
            amount: "2400.00",
            bindingDate: "2026-03-14",
            floor: "1000.00",
            clampedAtZero: false,
            shortfall: null,
          },
        }),
      ),
    ).toEqual([]);
  });

  it("escalates to critical when the balance itself goes negative", () => {
    // Below your own buffer and actually overdrawn are different sentences, and
    // the family acts on the second one differently.
    const [alert] = projectedShortfallAlerts(
      shortfall({ lowWaterMark: { date: "2026-03-14", balance: "-420.00" } }),
    );
    expect(alert?.severity).toBe("critical");
  });

  it("stays silent when there is no operating account to project", () => {
    expect(projectedShortfallAlerts(shortfall({ status: "no_operating_account" }))).toEqual([]);
  });

  it("stays silent on insufficient history", () => {
    // The app itself labels this projection as not-yet-trustworthy. Alerting on
    // it would turn the honest-degradation path into a nag — the same call
    // `adviceAlerts` makes for `unknown_input`.
    expect(projectedShortfallAlerts(shortfall({ status: "insufficient_history" }))).toEqual([]);
  });

  it("still fires on a run-rate-only projection", () => {
    // Thin, but not dishonest: a household with no confirmed bills that is
    // still projected short is short for reasons the run-rate already sees.
    expect(projectedShortfallAlerts(shortfall({ status: "run_rate_only" }))).toHaveLength(1);
  });

  it("stays silent when the horizon produced no low-water mark", () => {
    expect(projectedShortfallAlerts(shortfall({ lowWaterMark: null }))).toEqual([]);
  });

  it("does not re-nag while the same month stays short", () => {
    // ADR-026. The low-water date jitters by a day whenever a transaction posts;
    // hashing the date itself would fire a fresh alert on that jitter.
    const monday = projectedShortfallAlerts(shortfall());
    const tuesday = projectedShortfallAlerts(
      shortfall({
        lowWaterMark: { date: "2026-03-15", balance: "290.00" },
        safeToSpend: { ...SHORTFALL.safeToSpend, bindingDate: "2026-03-15", shortfall: "710.00" },
      }),
    );
    expect(tuesday[0]?.dedupHash).toBe(monday[0]?.dedupHash);
  });

  it("treats a shortfall in a later month as genuinely new", () => {
    const march = projectedShortfallAlerts(shortfall());
    const april = projectedShortfallAlerts(
      shortfall({ lowWaterMark: { date: "2026-04-02", balance: "100.00" } }),
    );
    expect(april[0]?.dedupHash).not.toBe(march[0]?.dedupHash);
  });

  it("keeps every figure out of the title", () => {
    const [alert] = projectedShortfallAlerts(shortfall());
    expect(alert?.title).not.toMatch(/\d/);
  });

  it("carries the horizon, floor and coverage so the number is auditable", () => {
    const [alert] = projectedShortfallAlerts(shortfall());
    expect(alert?.detail).toMatchObject({
      horizonDays: 60,
      cashFloor: "1000.00",
      coverage: "0.8200",
      href: "/plan/cashflow",
    });
  });
});

/* ── obligation_missed: one-shot, per occurrence ─────────────────────────── */

describe("obligationMissedAlerts", () => {
  it("names the bill and puts its amount in detail", () => {
    const [alert] = obligationMissedAlerts([missed()]);
    expect(alert?.type).toBe("obligation_missed");
    expect(alert?.title).toContain("Mortgage");
    expect(alert?.title).not.toMatch(/\d/);
    expect(alert?.detail).toMatchObject({
      obligationId: "ob-1",
      occurrenceId: "occ-1",
      dueDate: "2026-03-01",
      expectedAmount: "2150.00",
      href: "/plan/cashflow/review",
    });
  });

  it("fires for a missed receipt too, not only a missed payment", () => {
    // A rent cheque that did not arrive is at least as important as a bill that
    // did not go out, and the projection is wrong in the dangerous direction.
    const [alert] = obligationMissedAlerts([missed({ direction: "inflow" })]);
    expect(alert?.detail.direction).toBe("inflow");
  });

  it("gives each occurrence its own hash", () => {
    const alerts = obligationMissedAlerts([
      missed({ occurrenceId: "occ-1", dueDate: "2026-03-01" }),
      missed({ occurrenceId: "occ-2", dueDate: "2026-04-01" }),
    ]);
    expect(new Set(alerts.map((a) => a.dedupHash)).size).toBe(2);
  });

  it("is stable across runs for the same occurrence", () => {
    expect(obligationMissedAlerts([missed()])[0]?.dedupHash).toBe(
      obligationMissedAlerts([missed()])[0]?.dedupHash,
    );
  });

  it("says nothing when nothing was missed", () => {
    expect(obligationMissedAlerts([])).toEqual([]);
  });
});

/* ── obligation_amount_changed: one-shot, and deliberately quiet ─────────── */

describe("obligationAmountChangedAlerts", () => {
  it("fires when a fixed bill moves past the threshold", () => {
    const [alert] = obligationAmountChangedAlerts([changed()]);
    expect(alert?.type).toBe("obligation_amount_changed");
    expect(alert?.detail).toMatchObject({
      expectedAmount: "2150.00",
      matchedAmount: "-2400.00",
      amountDelta: "250.00",
    });
    expect(alert?.title).not.toMatch(/\d/);
  });

  it("ignores ordinary cent-level drift", () => {
    expect(obligationAmountChangedAlerts([changed({ amountDelta: "0.42" })])).toEqual([]);
  });

  it("uses a percentage of the bill, not a flat figure, on a large bill", () => {
    // 5% of $2,150 is $107.50 — a $60 move on a mortgage is noise, the same $60
    // on a $200 bill is not.
    expect(obligationAmountChangedAlerts([changed({ amountDelta: "60.00" })])).toEqual([]);
    expect(
      obligationAmountChangedAlerts([
        changed({ expectedAmount: "200.00", amountDelta: "60.00", matchedAmount: "-260.00" }),
      ]),
    ).toHaveLength(1);
  });

  it("keeps an absolute floor so a tiny bill does not fire on pennies", () => {
    // 5% of $14 is 70c. Without the floor, a $14 subscription rising to $14.80
    // would be an interruption.
    expect(
      obligationAmountChangedAlerts([
        changed({ expectedAmount: "14.00", amountDelta: "0.80", matchedAmount: "-14.80" }),
      ]),
    ).toEqual([]);
    expect(AMOUNT_CHANGE_THRESHOLD.abs).toBe("5.00");
  });

  it("fires on a decrease as well as an increase", () => {
    // A mortgage that posted $500 instead of $2,150 is not good news.
    const [alert] = obligationAmountChangedAlerts([
      changed({ amountDelta: "-1650.00", matchedAmount: "-500.00" }),
    ]);
    expect(alert?.detail.amountDelta).toBe("-1650.00");
  });

  it("never fires for a variable-amount obligation", () => {
    // A utility bill varying is what `trailing_median` means. Alerting on it
    // would produce a monthly interruption that carries no information.
    expect(
      obligationAmountChangedAlerts([
        changed({ amountMode: "trailing_median", amountDelta: "400.00" }),
      ]),
    ).toEqual([]);
  });

  it("is stable across runs for the same occurrence", () => {
    expect(obligationAmountChangedAlerts([changed()])[0]?.dedupHash).toBe(
      obligationAmountChangedAlerts([changed()])[0]?.dedupHash,
    );
  });

  it("does not collide with the missed alert for the same occurrence", () => {
    expect(obligationAmountChangedAlerts([changed()])[0]?.dedupHash).not.toBe(
      obligationMissedAlerts([missed()])[0]?.dedupHash,
    );
  });
});

/* ── The composed mapper ─────────────────────────────────────────────────── */

describe("cashFlowAlerts", () => {
  it("returns every type in one pass", () => {
    const all = cashFlowAlerts({
      shortfall: shortfall(),
      missed: [missed()],
      amountChanges: [changed()],
    });
    expect(all.map((a) => a.type).sort()).toEqual([
      "obligation_amount_changed",
      "obligation_missed",
      "projected_shortfall",
    ]);
  });

  it("only ever emits Phase-16 types", () => {
    const all = cashFlowAlerts({
      shortfall: shortfall(),
      missed: [missed()],
      amountChanges: [changed()],
    });
    for (const alert of all) {
      expect(CASHFLOW_ALERT_TYPES).toContain(alert.type);
    }
  });

  it("is empty on a household with nothing to say", () => {
    expect(cashFlowAlerts({ shortfall: null, missed: [], amountChanges: [] })).toEqual([]);
  });

  it("emits unique dedup hashes across the whole batch", () => {
    const all = cashFlowAlerts({
      shortfall: shortfall(),
      missed: [missed({ occurrenceId: "occ-1" }), missed({ occurrenceId: "occ-2" })],
      amountChanges: [changed({ occurrenceId: "occ-3" })],
    });
    expect(new Set(all.map((a) => a.dedupHash)).size).toBe(all.length);
  });
});
