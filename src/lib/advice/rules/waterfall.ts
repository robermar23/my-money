import Decimal from "decimal.js";
import { clampAtZero, gt, gte, isPositive, m, zero } from "../amounts.ts";
import { CASH_DRAG_MINIMUM_EXCESS, STARTER_BUFFER, limitsForYear } from "../constants.ts";
import type { AdviceInput } from "../snapshot.ts";
import {
  type InputUsed,
  type Recommendation,
  type Rule,
  type RungId,
  type RungState,
  type RungStatus,
  recommendationId,
} from "../types.ts";
import { cashExcess } from "./cash-drag.ts";
import { deferralPacing } from "./contribution-pacing.ts";
import { reserveMonthsFor } from "./emergency-fund.ts";
import { matchGaps } from "./employer-match.ts";
import { highInterestDebts, highInterestThreshold } from "./high-interest-debt.ts";
import { notRecorded, shown } from "./shared.ts";

/**
 * The waterfall (Phase 15, PLAN15 P15-22, ADR-034 §4).
 *
 * A fixed ordering of where the next dollar goes:
 *
 *   1. **Starter buffer** — a small flat cushion so the next flat tire is not
 *      financed.
 *   2. **Employer match** — the only guaranteed immediate return available.
 *   3. **High-interest debt** — a guaranteed return equal to the APR.
 *   4. **Full reserve** — 3–6 months of essential expenses.
 *   5. **IRA / HSA** — the tax-advantaged containers outside payroll.
 *   6. **Workplace plan to the statutory cap.**
 *   7. **Taxable and medium-term** — everything after the ceilings are used.
 *
 * ── These are DERIVED RUNGS, not goals (ADR-032 §6) ────────────────────────
 * The user cannot create, name, reorder, delete or fund a rung. Every target on
 * this list is computed from their own data — their essential expenses, their
 * employer's match cap, a statutory limit. That is what keeps ADR-022's
 * rejection of a multi-goal planner intact rather than quietly amended: this is
 * a diagnostic checklist, and there is no writable state behind it.
 *
 * ── The two-pass structure, and why `blocked` exists ───────────────────────
 * Each rung first computes its **intrinsic** state from the data alone. Then a
 * single ordering pass walks the list: rungs before the first unfinished one are
 * `done`, that one is the focus and keeps its own status, and every rung after
 * it becomes `blocked`. `blocked` is not a failure — it is the ordering
 * statement that gives a waterfall its name ("fund the match before the taxable
 * account").
 *
 * ── No rung is EVER `done` on absent data ──────────────────────────────────
 * This is the property the tests assert directly, and the most damaging thing
 * this feature could get wrong. A household with no cash accounts recorded does
 * not have a funded starter buffer; a household with no contribution rule on
 * file has not been shown to be capturing their match. Both report
 * `unknown_input`, which then blocks everything below — the honest consequence
 * of not knowing, and the thing that points the user at the input to fix.
 *
 * ── Known limitation: the IRA/HSA rung ─────────────────────────────────────
 * It reports `unknown_input` in every case, and that is not an oversight. The
 * app tracks *payroll* contributions (ADR-030); an IRA funded by a bank transfer
 * in April leaves no record it can read, and a balance is not a contribution.
 * Reporting the rung `done` because a Roth account has money in it would be
 * exactly the confident wrong answer this design exists to avoid.
 *
 * Pure and I/O-free. No tax math (ADR-032 §4) — `tax_treatment` orders
 * containers here and computes nothing.
 */

/** The fixed ordering. Index in this array is the rung's `order`. */
export const RUNG_ORDER: readonly RungId[] = [
  "starter_buffer",
  "employer_match",
  "high_interest_debt",
  "full_reserve",
  "ira_hsa",
  "workplace_plan",
  "taxable_medium_term",
];

const RUNG_LABELS: Readonly<Record<RungId, string>> = {
  starter_buffer: "Starter buffer",
  employer_match: "Employer match",
  high_interest_debt: "High-interest debt",
  full_reserve: "Full emergency reserve",
  ira_hsa: "IRA and HSA",
  workplace_plan: "Workplace plan to the annual cap",
  taxable_medium_term: "Taxable and medium-term savings",
};

/** What each rung function computes from the data alone. */
type RungCore = Omit<RungState, "order" | "label" | "blocking"> & {
  /** `true` only when the rung is genuinely satisfied on data we actually have. */
  readonly satisfied: boolean;
};

/**
 * A rung with its blocking flag attached, before the ordering pass.
 *
 * `blocking` is set in exactly one place ({@link intrinsicRungs}) so the list of
 * rungs that can dam the ones below them is readable at a glance — see
 * {@link RungState.blocking} and the file header on why IRA/HSA is the exception.
 */
type IntrinsicRung = RungCore & { readonly blocking: boolean };

/** `max(0, target − current)` as a money string, or `null` if either is unknown. */
function gapOf(target: string | null, current: string | null): string | null {
  if (target === null || current === null) return null;
  return clampAtZero(m(target).sub(m(current))).toString();
}

function starterBuffer(input: AdviceInput): RungCore {
  const accountCount =
    input.cash.operating.accounts.length +
    input.cash.reserve.accounts.length +
    input.cash.mediumTerm.accounts.length +
    input.cash.unclassified.accounts.length;

  const inputsUsed: InputUsed[] = [
    shown("Starter buffer target", STARTER_BUFFER, "money", "A flat, conventional first cushion"),
  ];

  if (accountCount === 0) {
    return {
      rung: "starter_buffer",
      status: "unknown_input",
      satisfied: false,
      reason:
        "No cash accounts are recorded, so there is no balance to measure a starter buffer against.",
      target: STARTER_BUFFER,
      current: null,
      gap: null,
      inputsUsed: [
        ...inputsUsed,
        notRecorded("Liquid cash", "money", "No cash accounts recorded", "/accounts"),
      ],
    };
  }

  const liquid = m(input.cash.liquid);
  const satisfied = gte(liquid, m(STARTER_BUFFER));
  return {
    rung: "starter_buffer",
    status: satisfied ? "done" : "in_progress",
    satisfied,
    reason: satisfied
      ? `You hold ${liquid.format()} in liquid cash, past the ${m(STARTER_BUFFER).format()} starter buffer.`
      : `You hold ${liquid.format()} in liquid cash against a ${m(STARTER_BUFFER).format()} starter buffer.`,
    target: STARTER_BUFFER,
    current: input.cash.liquid,
    gap: gapOf(STARTER_BUFFER, input.cash.liquid),
    inputsUsed: [
      ...inputsUsed,
      shown("Liquid cash", input.cash.liquid, "money", "Operating plus reserve balances"),
    ],
  };
}

function employerMatch(input: AdviceInput): RungCore {
  const gaps = matchGaps(input);

  if (gaps.length === 0) {
    return {
      rung: "employer_match",
      status: "unknown_input",
      satisfied: false,
      reason:
        "No paycheck contribution rule is recorded, so there is no employer match formula to check.",
      target: null,
      current: null,
      gap: null,
      inputsUsed: [
        notRecorded(
          "Employer match formula",
          "text",
          "Set on the paycheck that funds your retirement account",
          "/settings/income",
        ),
      ],
    };
  }

  const unknown = gaps.filter((g) => g.status === "unknown_input");
  const open = gaps.filter((g) => g.status === "gap");
  const claimed = gaps.reduce((acc, g) => acc.add(m(g.employerYtd)), zero());
  const unclaimed = open.reduce((acc, g) => acc.add(m(g.unclaimedYtd ?? "0")), zero());

  const inputsUsed: InputUsed[] = [
    shown(
      "Employer contributions this year",
      claimed.toString(),
      "money",
      "From the materialized contribution ledger",
      "/settings/income",
    ),
  ];

  if (unknown.length > 0) {
    return {
      rung: "employer_match",
      status: "unknown_input",
      satisfied: false,
      reason: `${unknown.length} contribution ${unknown.length === 1 ? "rule has" : "rules have"} no materialized pay periods this year, so the match cannot be measured.`,
      target: null,
      current: claimed.toString(),
      gap: null,
      inputsUsed: [
        ...inputsUsed,
        notRecorded(
          "Gross pay this year",
          "money",
          "No materialized pay periods for this year",
          "/settings/income",
        ),
      ],
    };
  }

  if (open.length > 0) {
    const target = claimed.add(unclaimed);
    return {
      rung: "employer_match",
      status: "in_progress",
      satisfied: false,
      reason: `${unclaimed.format()} of employer money has gone unclaimed so far this year.`,
      target: target.toString(),
      current: claimed.toString(),
      gap: unclaimed.toString(),
      inputsUsed,
    };
  }

  const noMatchOffered = gaps.every((g) => g.status === "no_match");
  return {
    rung: "employer_match",
    status: "done",
    satisfied: true,
    reason: noMatchOffered
      ? "Your recorded plans offer no employer match, so there is nothing to capture here."
      : `You are capturing the full match your plans offer — ${claimed.format()} so far this year.`,
    target: claimed.toString(),
    current: claimed.toString(),
    gap: "0.00",
    inputsUsed,
  };
}

function highInterestDebtRung(input: AdviceInput): RungCore {
  const threshold = highInterestThreshold(input);
  const thresholdPercent = new Decimal(threshold.apr).times(100).toDecimalPlaces(2).toString();
  const withBalance = input.debts.filter((debt) => isPositive(m(debt.balance)));
  const unrated = withBalance.filter((debt) => debt.apr === null);

  const thresholdInput = shown(
    "High-interest threshold",
    thresholdPercent,
    "percent",
    threshold.source === "household" ? "Your household setting" : "The app default",
    "/settings/household",
  );

  if (unrated.length > 0) {
    return {
      rung: "high_interest_debt",
      status: "unknown_input",
      satisfied: false,
      reason: `${unrated.length} ${unrated.length === 1 ? "debt has" : "debts have"} no APR recorded, so we cannot tell whether it is above your ${thresholdPercent}% line.`,
      target: "0.00",
      current: null,
      gap: null,
      inputsUsed: [
        thresholdInput,
        notRecorded("APR", "percent", "Entered on the account's terms", "/accounts"),
      ],
    };
  }

  const flagged = highInterestDebts(input);
  const balance = flagged.reduce((acc, debt) => acc.add(m(debt.balance)), zero());

  return {
    rung: "high_interest_debt",
    status: flagged.length === 0 ? "done" : "in_progress",
    satisfied: flagged.length === 0,
    reason:
      flagged.length === 0
        ? `None of your debt is above ${thresholdPercent}% APR.`
        : `${balance.format()} across ${flagged.length} ${flagged.length === 1 ? "debt" : "debts"} sits above ${thresholdPercent}% APR.`,
    target: "0.00",
    current: balance.toString(),
    gap: balance.toString(),
    inputsUsed: [
      thresholdInput,
      shown("High-interest balance", balance.toString(), "money", "Debts above the threshold"),
    ],
  };
}

function fullReserve(input: AdviceInput): RungCore {
  const target = reserveMonthsFor(input);

  if (input.essentials.baseline === null) {
    return {
      rung: "full_reserve",
      status: "unknown_input",
      satisfied: false,
      reason:
        "There is not enough classified spending history to compute essential monthly expenses, so the reserve cannot be sized.",
      target: null,
      current: input.cash.reserve.total,
      gap: null,
      inputsUsed: [
        notRecorded(
          "Essential monthly expenses",
          "money",
          "Median monthly spend in categories marked essential",
          "/settings/categories",
        ),
      ],
    };
  }

  const targetAmount = m(input.essentials.baseline).mul(target.months);
  const current = m(input.cash.reserve.total);
  const satisfied = gte(current, targetAmount);

  return {
    rung: "full_reserve",
    status: satisfied ? "done" : "in_progress",
    satisfied,
    reason: satisfied
      ? `${current.format()} in reserve savings covers your ${target.months}-month target.`
      : `${current.format()} in reserve savings against a ${targetAmount.format()} target. ${target.reason}`,
    target: targetAmount.toString(),
    current: current.toString(),
    gap: gapOf(targetAmount.toString(), current.toString()),
    inputsUsed: [
      shown(
        "Essential monthly expenses",
        input.essentials.baseline,
        "money",
        `Median of ${input.essentials.basisMonths} months`,
        "/settings/categories",
      ),
      shown("Reserve target", `${target.months}`, "months", target.reason, "/settings/household"),
      shown(
        "Reserve savings",
        input.cash.reserve.total,
        "money",
        "Savings and money-market balances",
        "/accounts",
      ),
    ],
  };
}

function iraHsa(input: AdviceInput): RungCore {
  const containers = input.accounts.filter(
    (a) => a.taxTreatment === "roth" || a.taxTreatment === "hsa",
  );
  const balance = m(input.holdings.roth).add(m(input.holdings.hsa));

  if (containers.length === 0) {
    return {
      rung: "ira_hsa",
      status: "unknown_input",
      satisfied: false,
      reason:
        "No Roth IRA or HSA account is recorded, so the app cannot tell whether one is being funded.",
      target: null,
      current: null,
      gap: null,
      inputsUsed: [
        notRecorded(
          "Roth IRA or HSA account",
          "text",
          "Set an account's tax treatment to include it here",
          "/accounts",
        ),
      ],
    };
  }

  // A balance is not a contribution. See the file header — this rung is
  // permanently unknown by design, not by omission.
  return {
    rung: "ira_hsa",
    status: "unknown_input",
    satisfied: false,
    reason: `You hold ${balance.format()} across ${containers.length} tax-advantaged ${containers.length === 1 ? "account" : "accounts"}, but the app only tracks payroll contributions — it cannot see an IRA or HSA funded by transfer, so it will not claim this rung is done.`,
    target: null,
    current: balance.toString(),
    gap: null,
    inputsUsed: [
      shown(
        "Roth and HSA balances",
        balance.toString(),
        "money",
        "Latest account snapshots",
        "/investments",
      ),
      notRecorded(
        "Contributions this year",
        "money",
        "Only payroll contributions are tracked",
        "/settings/income",
      ),
    ],
  };
}

function workplacePlan(input: AdviceInput): RungCore {
  const limits = limitsForYear(input.contributionYear);

  if (limits === null) {
    return {
      rung: "workplace_plan",
      status: "unknown_input",
      satisfied: false,
      // The one sentence ADR-034 §5 exists to produce, naming the file that
      // fixes it (ADR-053 §2), so the gap is actionable rather than mysterious.
      reason: `The contribution limit is not configured for ${input.contributionYear}, so this cannot be paced. Last year's ceiling would be the wrong number. The IRS publishes each year's limits in the autumn; add a ${input.contributionYear} row to STATUTORY_LIMITS in src/lib/advice/constants.ts.`,
      target: null,
      current: null,
      gap: null,
      inputsUsed: [
        notRecorded(
          `${input.contributionYear} elective-deferral limit`,
          "money",
          "Not configured in this build of the app",
        ),
      ],
    };
  }

  const pacing = deferralPacing(input);
  if (pacing === null || input.contributionRules.length === 0) {
    return {
      rung: "workplace_plan",
      status: "unknown_input",
      satisfied: false,
      reason:
        "No paycheck contribution rule is recorded, so there is nothing to pace against the annual limit.",
      target: limits.electiveDeferral,
      current: null,
      gap: null,
      inputsUsed: [
        shown(
          `${input.contributionYear} elective-deferral limit`,
          limits.electiveDeferral,
          "money",
          "Statutory limit, checked into the app",
        ),
        notRecorded(
          "Your contributions this year",
          "money",
          "No contribution rule recorded",
          "/settings/income",
        ),
      ],
    };
  }

  const satisfied = gte(m(pacing.employeeYtd), m(pacing.limit));
  return {
    rung: "workplace_plan",
    status: satisfied ? "done" : "in_progress",
    satisfied,
    reason: satisfied
      ? `You have contributed ${m(pacing.employeeYtd).format()}, reaching the ${pacing.year} limit.`
      : `${m(pacing.employeeYtd).format()} contributed against a ${m(pacing.limit).format()} ${pacing.year} limit, projecting to ${m(pacing.projectedAnnual).format()}.`,
    target: pacing.limit,
    current: pacing.employeeYtd,
    gap: pacing.remaining,
    inputsUsed: [
      shown(
        `${pacing.year} elective-deferral limit`,
        pacing.limit,
        "money",
        "Statutory limit, checked into the app",
      ),
      shown(
        "Your contributions this year",
        pacing.employeeYtd,
        "money",
        `${pacing.periods} materialized pay periods`,
        "/settings/income",
      ),
    ],
  };
}

function taxableMediumTerm(input: AdviceInput): RungCore {
  const excess = cashExcess(input);

  if (excess.excess === null) {
    return {
      rung: "taxable_medium_term",
      status: "unknown_input",
      satisfied: false,
      reason:
        "Idle cash is measured against essential monthly expenses, which cannot be computed yet.",
      target: null,
      current: null,
      gap: null,
      inputsUsed: [
        notRecorded(
          "Essential monthly expenses",
          "money",
          "Median monthly spend in categories marked essential",
          "/settings/categories",
        ),
      ],
    };
  }

  const idle = m(excess.excess);
  const satisfied = !gt(idle, m(CASH_DRAG_MINIMUM_EXCESS));

  return {
    rung: "taxable_medium_term",
    status: satisfied ? "done" : "in_progress",
    satisfied,
    reason: satisfied
      ? "No meaningful amount of cash is sitting idle beyond your operating and reserve targets."
      : `${idle.format()} is sitting in cash beyond your operating and reserve targets.`,
    target: "0.00",
    current: excess.excess,
    gap: satisfied ? "0.00" : excess.excess,
    inputsUsed: [
      shown("Liquid cash", excess.liquid, "money", "Operating plus reserve balances"),
      shown(
        "Idle beyond target",
        excess.excess,
        "money",
        "Liquid cash above the operating and reserve targets",
      ),
    ],
  };
}

/**
 * Every rung's intrinsic state, before the ordering pass.
 *
 * The `blocking` flags live here and nowhere else. Six rungs dam the ones below
 * them; `ira_hsa` does not, because its unknown is structural — the app tracks
 * payroll contributions and will never see an IRA funded by transfer, so making
 * it a hard stop would permanently blockade the two rungs beneath it for every
 * household in the world.
 */
function intrinsicRungs(input: AdviceInput): IntrinsicRung[] {
  return [
    { ...starterBuffer(input), blocking: true },
    { ...employerMatch(input), blocking: true },
    { ...highInterestDebtRung(input), blocking: true },
    { ...fullReserve(input), blocking: true },
    { ...iraHsa(input), blocking: false },
    { ...workplacePlan(input), blocking: true },
    { ...taxableMediumTerm(input), blocking: true },
  ];
}

/**
 * The waterfall, in fixed ADR-034 §4 order (P15-22).
 *
 * @param input - The assembled snapshot.
 * @returns Seven rungs: the satisfied ones `done`, the first unfinished one
 *   holding its own status, and every rung after it `blocked`.
 */
export function evaluateWaterfall(input: AdviceInput): RungState[] {
  const intrinsic = intrinsicRungs(input);
  // The focus is the first BLOCKING rung that is not satisfied. Rungs above it
  // report their own state (which may itself be a non-blocking `unknown_input`);
  // rungs below it are blocked behind it.
  const focus = intrinsic.findIndex((rung) => rung.blocking && !rung.satisfied);
  const focusLabel = focus === -1 ? null : RUNG_LABELS[intrinsic[focus]?.rung ?? "starter_buffer"];

  return intrinsic.map((rung, index) => {
    const base = { rung: rung.rung, order: index, label: RUNG_LABELS[rung.rung] };

    if (focus === -1 || index <= focus) {
      return { ...base, ...toState(rung, rung.satisfied ? "done" : rung.status) };
    }
    return {
      ...base,
      ...toState(rung, "blocked"),
      reason: `Comes after ${focusLabel}, which is not finished yet.`,
    };
  });
}

/** Strip the internal `satisfied` flag and stamp the final status. */
function toState(
  rung: IntrinsicRung,
  status: RungStatus,
): Omit<RungState, "rung" | "order" | "label"> {
  return {
    status,
    reason: rung.reason,
    target: rung.target,
    current: rung.current,
    gap: rung.gap,
    blocking: rung.blocking,
    inputsUsed: rung.inputsUsed,
  };
}

/**
 * The rung the household should be working on next, or `null` when every
 * blocking rung is finished.
 *
 * Reads `blocking` rather than "the first thing that is not done", so a rung the
 * app structurally cannot verify (IRA/HSA) is reported in the list without
 * becoming a permanent answer to "what should I do next".
 */
export function focusRung(rungs: readonly RungState[]): RungState | null {
  return rungs.find((rung) => rung.blocking && rung.status !== "done") ?? null;
}

export const waterfallRule: Rule = {
  id: "waterfall",
  title: "Where your next dollar goes",
  // Composes rules with a range of history requirements; the reserve rung needs
  // the essential baseline, so the composite inherits its floor.
  minMonthsHistory: 3,

  evaluate(input: AdviceInput): Recommendation[] {
    const rungs = evaluateWaterfall(input);
    const focus = focusRung(rungs);
    const id = recommendationId("waterfall", "");
    const heuristic =
      "Starter buffer → employer match → high-interest debt → full reserve → IRA/HSA → workplace plan → taxable";

    if (focus === null) {
      return [
        {
          id,
          ruleId: "waterfall",
          subjectKey: "",
          severity: "info",
          status: "ok",
          title: "You have worked through the whole waterfall",
          rationale:
            "Every rung the app can verify is satisfied: a starter buffer, the full employer match, no high-interest debt, a complete reserve, and your annual contribution room used. IRA and HSA funding outside payroll is not something the app can see, so check that one yourself.",
          heuristic,
          benchmark: null,
          currentValue: null,
          suggestedValue: null,
          impact: "0.00",
          inputsUsed: [],
          confidence: "high",
        },
      ];
    }

    const unknown = focus.status === "unknown_input";
    return [
      {
        id,
        ruleId: "waterfall",
        subjectKey: "",
        severity: "info",
        status: unknown ? "unknown_input" : "action",
        title: unknown
          ? `Next up: ${focus.label} — but we are missing an input`
          : `Your next dollar goes to: ${focus.label}`,
        rationale: `${focus.reason} ${rungs.filter((r) => r.status === "done").length} of ${rungs.length} rungs are complete.`,
        heuristic,
        benchmark: focus.target,
        currentValue: focus.current,
        suggestedValue: focus.target,
        impact: focus.gap,
        inputsUsed: focus.inputsUsed,
        confidence: unknown ? "low" : "high",
      },
    ];
  },
};
