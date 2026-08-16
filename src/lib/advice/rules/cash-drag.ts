import Decimal from "decimal.js";
import { clampAtZero, gt, isPositive, m, percentOf, zero } from "../amounts.ts";
import {
  CASH_DRAG_MINIMUM_EXCESS,
  DEFAULT_LADDER_INTERVAL_MONTHS,
  DEFAULT_LADDER_RUNGS,
  OPERATING_TARGET_MONTHS,
} from "../constants.ts";
import type { AdviceInput } from "../snapshot.ts";
import { type InputUsed, type Recommendation, type Rule, recommendationId } from "../types.ts";
import { reserveMonthsFor } from "./emergency-fund.ts";
import { baselineConfidence, notRecorded, shown } from "./shared.ts";

/**
 * The cash-drag rule (Phase 15, PLAN15 P15-20, ADR-034 §4 rung 7).
 *
 * Answers Round 9's "how much to keep on hand and how much in medium-term
 * savings like CD's" from the other side: once operating cash and the full
 * reserve are covered, everything still sitting in a savings account is idle.
 *
 * ── The product boundary is the whole point of this rule ───────────────────
 * ADR-032 §4 forbids naming a security, fund, institution or product. So this
 * rule recommends a **structure and an amount** — "$18,000 across four rungs
 * maturing three months apart" — and never a bank, a rate, or a ticker. The
 * ladder shape is itself the recommendation: committed money that is
 * nonetheless never more than one interval away from being liquid again, which
 * is precisely what makes a CD tolerable for money you might need.
 *
 * ── Forgone yield is shown only when it can be computed, not estimated ─────
 * ADR-033 rejected live rate fetching outright, and this rule is why that was
 * affordable: the only thing a market rate would tell us is "what yield are you
 * giving up", and `household_profile.benchmark_savings_apy` answers it with zero
 * egress and no staleness story. The figure appears **only when both sides are
 * recorded** — the user's benchmark AND an APY on every reserve account holding
 * the money. One blank APY and the number is `null`, with the reason shown;
 * quietly assuming 0% would manufacture a dramatic figure out of missing data.
 *
 * ── Why the excess is measured against operating + reserve ─────────────────
 * `liquid` is operating plus reserve (CDs and unclassified cash are already
 * excluded by [cash-tiers.ts](../cash-tiers.ts)). The target it is measured
 * against is one month of essentials for operating plus the same 3-or-6 month
 * multiplier the emergency-fund rule chose — read from
 * {@link reserveMonthsFor}, not re-derived, so the two rules can never disagree
 * about how big the reserve should be.
 *
 * Pure and I/O-free.
 */

/** One rung of a suggested ladder. A shape and a date — never a product. */
export interface LadderRung {
  /** 1-based position. */
  readonly index: number;
  readonly amount: string;
  /** Months from today until this rung matures. */
  readonly maturityMonths: number;
  /** `YYYY-MM-DD`. */
  readonly maturityDate: string;
}

export interface CashExcess {
  /** `OPERATING_TARGET_MONTHS × essentials`. `null` with no baseline. */
  readonly operatingTarget: string | null;
  /** `reserveMonths × essentials`. `null` with no baseline. */
  readonly reserveTarget: string | null;
  readonly reserveMonths: number;
  readonly liquid: string;
  /** Liquid cash beyond both targets, floored at zero. `null` with no baseline. */
  readonly excess: string | null;
  /** Balance-weighted APY across reserve accounts, as a PERCENTAGE. */
  readonly weightedApy: string | null;
  /** The household's own benchmark, as a PERCENTAGE. */
  readonly benchmarkApy: string | null;
  /** `excess × (benchmark − weighted) / 100`. `null` unless both sides are known. */
  readonly forgoneAnnualYield: string | null;
  /** Reserve accounts with no APY recorded — why `weightedApy` may be `null`. */
  readonly accountsMissingApy: number;
}

/** Add whole months to an ISO date, clamping the day to the target month. */
function addMonths(date: string, months: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  // Clamp: 31 January + 1 month is 28/29 February, not 3 March.
  const daysInMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInMonth));
  return target.toISOString().slice(0, 10);
}

/**
 * How much liquid cash is beyond what the household needs on hand (P15-20).
 *
 * @param input - The assembled snapshot.
 * @returns Targets, excess, and the forgone-yield figure when both rate inputs
 *   are recorded.
 */
export function cashExcess(input: AdviceInput): CashExcess {
  const reserveMonths = reserveMonthsFor(input).months;
  const benchmarkApy = input.household.profile?.benchmarkSavingsApy ?? null;
  const liquid = m(input.cash.liquid);

  // Balance-weighted APY across the reserve tier — where excess cash actually
  // sits. Operating cash is committed to this month's bills and rarely earns.
  const reserveAccounts = input.cash.reserve.accounts;
  const accountsMissingApy = reserveAccounts.filter((a) => a.apy === null).length;
  let weightedApy: string | null = null;
  if (reserveAccounts.length > 0 && accountsMissingApy === 0) {
    const total = reserveAccounts.reduce((acc, a) => acc.add(m(a.balance)), zero());
    if (isPositive(total)) {
      const weighted = reserveAccounts.reduce(
        (acc, a) => acc.plus(new Decimal(a.balance).times(new Decimal(a.apy ?? "0"))),
        new Decimal(0),
      );
      weightedApy = weighted.dividedBy(new Decimal(total.toString())).toDecimalPlaces(4).toString();
    }
  }

  if (input.essentials.baseline === null) {
    return {
      operatingTarget: null,
      reserveTarget: null,
      reserveMonths,
      liquid: liquid.toString(),
      excess: null,
      weightedApy,
      benchmarkApy,
      forgoneAnnualYield: null,
      accountsMissingApy,
    };
  }

  const essential = m(input.essentials.baseline);
  const operatingTarget = essential.mul(OPERATING_TARGET_MONTHS);
  const reserveTarget = essential.mul(reserveMonths);
  const excess = clampAtZero(liquid.sub(operatingTarget).sub(reserveTarget));

  let forgoneAnnualYield: string | null = null;
  if (benchmarkApy !== null && weightedApy !== null && isPositive(excess)) {
    const spread = new Decimal(benchmarkApy).minus(new Decimal(weightedApy));
    // Only a POSITIVE spread is a finding. Earning more than your own benchmark
    // is not a problem to solve, and a negative "forgone yield" is nonsense.
    if (spread.greaterThan(0)) {
      forgoneAnnualYield = percentOf(excess, spread.toString()).toString();
    }
  }

  return {
    operatingTarget: operatingTarget.toString(),
    reserveTarget: reserveTarget.toString(),
    reserveMonths,
    liquid: liquid.toString(),
    excess: excess.toString(),
    weightedApy,
    benchmarkApy,
    forgoneAnnualYield,
    accountsMissingApy,
  };
}

/**
 * Split an amount into equal ladder rungs with staggered maturities.
 *
 * The final rung absorbs the rounding remainder so the rungs sum to the input
 * exactly — four rungs of `$X / 4` rounded independently would lose or invent
 * cents (CLAUDE.md §Money).
 *
 * @param amount - Total to ladder.
 * @param today - Reference date, `YYYY-MM-DD`.
 * @param rungs - Number of rungs. Default {@link DEFAULT_LADDER_RUNGS}.
 * @param intervalMonths - Months between maturities. Default 3.
 * @returns The rungs, earliest maturity first.
 *
 * Exported rather than embedded in the {@link Recommendation}: the recommendation
 * shape is uniform across every rule (ADR-032 §2) and gains no per-rule payload,
 * so the surface that wants to draw the ladder calls this with
 * `recommendation.suggestedValue` and today's date.
 */
export function suggestLadder(
  amount: string,
  today: string,
  rungs: number = DEFAULT_LADDER_RUNGS,
  intervalMonths: number = DEFAULT_LADDER_INTERVAL_MONTHS,
): LadderRung[] {
  const count = Math.max(1, Math.floor(rungs));
  const total = m(amount);
  const per = total.div(count);

  const result: LadderRung[] = [];
  let allocated = zero();
  for (let i = 0; i < count; i += 1) {
    const last = i === count - 1;
    const rungAmount = last ? total.sub(allocated) : per;
    allocated = allocated.add(rungAmount);
    const maturityMonths = intervalMonths * (i + 1);
    result.push({
      index: i + 1,
      amount: rungAmount.toString(),
      maturityMonths,
      maturityDate: addMonths(today, maturityMonths),
    });
  }
  return result;
}

export const cashDragRule: Rule = {
  id: "cash_drag",
  title: "Idle cash",
  // Sized against the essential baseline, so it needs the same floor the
  // emergency-fund rule does (ADR-034 §7).
  minMonthsHistory: 3,

  evaluate(input: AdviceInput): Recommendation[] {
    const excess = cashExcess(input);
    const id = recommendationId("cash_drag", "");
    const heuristic =
      "Hold about a month of expenses in operating cash and a full reserve in savings; ladder the rest";

    if (excess.excess === null) {
      return [
        {
          id,
          ruleId: "cash_drag",
          subjectKey: "",
          severity: "info",
          status: "unknown_input",
          title: "We cannot tell how much of your cash is idle",
          rationale:
            "Idle cash is whatever sits above your operating needs and your emergency fund, and both are sized against essential monthly expenses — which there is not yet enough classified spending to compute.",
          heuristic,
          benchmark: null,
          currentValue: excess.liquid,
          suggestedValue: null,
          impact: null,
          inputsUsed: [
            notRecorded(
              "Essential monthly expenses",
              "money",
              "Median monthly spend in categories marked essential",
              "/settings/categories",
            ),
            shown("Liquid cash", excess.liquid, "money", "Operating plus reserve balances"),
          ],
          confidence: "low",
        },
      ];
    }

    const amount = m(excess.excess);
    const inputsUsed: InputUsed[] = [
      shown(
        "Liquid cash",
        excess.liquid,
        "money",
        "Operating plus reserve balances — CDs excluded",
      ),
      shown(
        "Operating target",
        excess.operatingTarget ?? "0.00",
        "money",
        `${OPERATING_TARGET_MONTHS} month of essential expenses`,
      ),
      shown(
        "Reserve target",
        excess.reserveTarget ?? "0.00",
        "money",
        `${excess.reserveMonths} months of essential expenses`,
        "/settings/household",
      ),
    ];

    if (!gt(amount, m(CASH_DRAG_MINIMUM_EXCESS))) {
      return [
        {
          id,
          ruleId: "cash_drag",
          subjectKey: "",
          severity: "info",
          status: "ok",
          title: "Your cash is about the right size",
          rationale: isPositive(amount)
            ? `${amount.format()} sits above your operating and reserve targets, which is too little to be worth structuring.`
            : "Your liquid cash is at or below what you need on hand, so none of it is idle.",
          heuristic,
          benchmark: null,
          currentValue: excess.liquid,
          suggestedValue: null,
          impact: "0.00",
          inputsUsed,
          confidence: baselineConfidence(input),
        },
      ];
    }

    const ladder = suggestLadder(excess.excess, input.today);
    const perRung = ladder[0]?.amount ?? "0.00";

    // The yield inputs, shown either way — a missing APY is the reason the
    // forgone-yield figure is absent, so the user should see which one is blank.
    if (excess.benchmarkApy === null) {
      inputsUsed.push(
        notRecorded(
          "Your cash-yield benchmark",
          "percent",
          "Set it in household settings to see what idle cash is costing you",
          "/settings/household",
        ),
      );
    } else {
      inputsUsed.push(
        shown(
          "Your cash-yield benchmark",
          excess.benchmarkApy,
          "percent",
          "From your household settings",
          "/settings/household",
        ),
      );
    }

    if (excess.weightedApy === null) {
      inputsUsed.push(
        notRecorded(
          "Current yield on your savings",
          "percent",
          excess.accountsMissingApy > 0
            ? `${excess.accountsMissingApy} savings ${excess.accountsMissingApy === 1 ? "account has" : "accounts have"} no APY recorded`
            : "No savings accounts to measure",
          "/accounts",
        ),
      );
    } else {
      inputsUsed.push(
        shown(
          "Current yield on your savings",
          excess.weightedApy,
          "percent",
          "Balance-weighted across your savings accounts",
          "/accounts",
        ),
      );
    }

    const yieldSentence =
      excess.forgoneAnnualYield === null
        ? excess.benchmarkApy === null
          ? " Record the yield you believe you could get, in household settings, and this will also show what the gap costs you each year."
          : " Record an APY on your savings accounts and this will also show what the gap costs you each year."
        : ` At your own benchmark that gap is worth about ${m(excess.forgoneAnnualYield).format()} a year.`;

    return [
      {
        id,
        ruleId: "cash_drag",
        subjectKey: "",
        severity: "info",
        status: "action",
        title: `${amount.format()} of your cash is beyond what you need on hand`,
        rationale: `You hold ${m(excess.liquid).format()} in liquid cash against a ${m(excess.operatingTarget ?? "0").format()} operating target and a ${m(excess.reserveTarget ?? "0").format()} reserve. A ${ladder.length}-rung ladder — ${m(perRung).format()} maturing every ${DEFAULT_LADDER_INTERVAL_MONTHS} months — commits the difference while keeping some of it within reach at all times.${yieldSentence}`,
        heuristic,
        benchmark: excess.reserveTarget,
        currentValue: excess.liquid,
        suggestedValue: amount.toString(),
        impact: excess.forgoneAnnualYield ?? amount.toString(),
        inputsUsed,
        confidence: baselineConfidence(input),
      },
    ];
  },
};
