import { clampAtZero, m, zero } from "../amounts.ts";
import { DEFAULT_SPLIT, SPLIT_TOLERANCE_POINTS } from "../constants.ts";
import type { AdviceInput } from "../snapshot.ts";
import { medianMoney, shareOf } from "../statistics.ts";
import { type Recommendation, type Rule, type Severity, recommendationId } from "../types.ts";
import { baselineConfidence, completeMonths, notRecorded, shown } from "./shared.ts";

/**
 * The 50/30/20 split diagnostic (Phase 15, PLAN15 P15-26).
 *
 * ── A diagnostic, not a prescription ───────────────────────────────────────
 * This rule's entire output is a sentence of the form *"your needs are 62% of
 * take-home against a 50% target"*. It does not tell the household to move house
 * or cancel a subscription, and it must not: 50/30/20 is a rule of thumb about
 * proportions, and the household living in an expensive city on a modest salary
 * is not doing anything wrong by failing it. What the number is *for* is
 * recognising that the reason nothing is left over at the end of the month is
 * structural rather than a discipline problem — which is a genuinely useful
 * thing to learn, and a completely different conversation from "spend less".
 *
 * The framing shows up in the code as a ceiling on severity: a household off
 * target gets `warning` at worst, never `critical`, and the phrasing reports
 * rather than instructs.
 *
 * ── How the three buckets are derived ──────────────────────────────────────
 *   - **Needs** = median monthly `necessity='essential'` spend **plus minimum
 *     debt service**. The mortgage payment is the largest need most households
 *     have and it lives in `liabilities`, not in a spend category — the same
 *     reasoning that puts it in the essential baseline (P15-09).
 *   - **Wants** = median monthly `necessity='discretionary'` spend.
 *   - **Saved** = take-home − needs − wants − unclassified, floored at zero.
 *
 * Saving is measured as **what was left**, not as what landed in a category
 * marked `necessity='savings'`. Money that simply stayed in checking was saved
 * just as surely as money that was transferred out, and most transfers to
 * savings are `kind='transfer'` and excluded from spend entirely (ADR-018), so
 * counting only the savings bucket would report a household saving 20% as saving
 * nothing. Subtracting the savings bucket and adding it back is the same
 * arithmetic as not subtracting it, so it does not appear in the formula.
 *
 * ── Unclassified spend is subtracted, never assumed ────────────────────────
 * Spend the app could not classify is real money that left the household, so it
 * comes out of the residual. It is deliberately **not** guessed into needs or
 * wants: doing so would move the headline percentage by however much the user
 * has not classified yet, which is precisely the confident-wrong-number failure
 * ADR-032 exists to prevent. It is reported as its own input instead, and it
 * drags confidence down through {@link baselineConfidence}.
 *
 * Pure and I/O-free (ADR-032 §1).
 */

/** The three shares, as observed and as targeted. */
export interface SplitDiagnostic {
  /** Median monthly take-home the shares are measured against. */
  readonly income: string;
  readonly needs: string;
  readonly wants: string;
  readonly saved: string;
  /** Spend the app could not classify — subtracted from `saved`, never guessed. */
  readonly unclassified: string;
  /** Observed shares of `income`, in [0, ∞). */
  readonly observed: { readonly needs: number; readonly wants: number; readonly saved: number };
  /** Target percentages ("50.00"), from the household profile or the default. */
  readonly target: { readonly needs: string; readonly wants: string; readonly savings: string };
  /** True when the targets came from `household_profile` rather than the default. */
  readonly targetIsCustom: boolean;
  /** Complete months behind the medians. */
  readonly basisMonths: number;
}

/** A ratio as a display percentage: 0.6231 → "62.3". */
function ratioPercent(ratio: number): string {
  return (ratio * 100).toFixed(1);
}

/** A stored percentage string ("50.00") as a display percentage ("50"). */
function targetPercent(percent: string): string {
  return Number.parseFloat(percent).toString();
}

/**
 * Compute the observed split against the household's targets (P15-26).
 *
 * @param input - The assembled snapshot.
 * @returns The diagnostic, or `null` when take-home or the necessity split is
 *   not knowable — in which case there is no denominator and no percentage.
 */
export function splitDiagnostic(input: AdviceInput): SplitDiagnostic | null {
  const income = input.netIncome.trailingMedian;
  if (income === null || m(income).isZero() || m(income).isNegative()) return null;

  const months = completeMonths(input.essentials.monthly, input.today);
  if (months.length === 0) return null;

  // Drop the leading run of inactive months for the same reason the baselines
  // do: a window that starts before the history did is not evidence of zero
  // spending. Same trim as computeEssentialBaseline.
  const firstActive = months.findIndex((month) => !m(month.total).isZero());
  if (firstActive === -1) return null;
  const basis = months.slice(firstActive);

  const essential = medianMoney(basis.map((month) => month.essential)) ?? "0.00";
  const wants = medianMoney(basis.map((month) => month.discretionary)) ?? "0.00";
  const unclassified = medianMoney(basis.map((month) => month.unclassified)) ?? "0.00";
  const needs = m(essential).add(m(input.minimumDebtService.total));
  const saved = clampAtZero(m(income).sub(needs).sub(m(wants)).sub(m(unclassified)));

  const profile = input.household.profile;
  const targetIsCustom =
    profile?.needsPct !== null &&
    profile?.needsPct !== undefined &&
    profile.wantsPct !== null &&
    profile.savingsPct !== null;

  return {
    income,
    needs: needs.toString(),
    wants: m(wants).toString(),
    saved: saved.toString(),
    unclassified: m(unclassified).toString(),
    observed: {
      needs: shareOf(needs.toString(), income),
      wants: shareOf(wants, income),
      saved: shareOf(saved.toString(), income),
    },
    target: targetIsCustom
      ? {
          needs: profile?.needsPct ?? DEFAULT_SPLIT.needs,
          wants: profile?.wantsPct ?? DEFAULT_SPLIT.wants,
          savings: profile?.savingsPct ?? DEFAULT_SPLIT.savings,
        }
      : DEFAULT_SPLIT,
    targetIsCustom,
    basisMonths: basis.length,
  };
}

export const needsWantsSplitRule: Rule = {
  id: "needs_wants_split",
  title: "Needs / wants / savings split",
  // Six months: a proportion computed from three is dominated by whichever
  // quarterly bill happened to land inside the window.
  minMonthsHistory: 6,

  evaluate(input: AdviceInput): Recommendation[] {
    const split = splitDiagnostic(input);
    const heuristicFor = (target: SplitDiagnostic["target"]): string =>
      `Spend about ${targetPercent(target.needs)}% of take-home on needs, ${targetPercent(target.wants)}% on wants, and keep ${targetPercent(target.savings)}%`;

    if (split === null) {
      const missingIncome = input.netIncome.trailingMedian === null;
      return [
        {
          id: recommendationId("needs_wants_split", ""),
          ruleId: "needs_wants_split",
          subjectKey: "",
          severity: "info",
          status: "unknown_input",
          title: "Not enough recorded to measure your needs and wants split",
          rationale: missingIncome
            ? "This is a share of take-home pay, and no income has been observed yet. Categorize the deposits that are your pay and the split becomes computable."
            : "This compares essential spend against discretionary spend, and no month of spend has been classified yet.",
          heuristic: heuristicFor(DEFAULT_SPLIT),
          benchmark: null,
          currentValue: null,
          suggestedValue: null,
          impact: null,
          inputsUsed: [
            missingIncome
              ? notRecorded(
                  "Observed take-home",
                  "money",
                  "Median of monthly income categories",
                  "/settings/categories",
                )
              : shown(
                  "Observed take-home",
                  input.netIncome.trailingMedian ?? "0.00",
                  "money",
                  "Median monthly income",
                ),
            notRecorded(
              "Spend classified as essential or discretionary",
              "money",
              "Category necessity",
              "/settings/categories",
            ),
          ],
          confidence: "low",
        },
      ];
    }

    const heuristic = heuristicFor(split.target);
    const tolerance = SPLIT_TOLERANCE_POINTS / 100;
    const needsTarget = Number.parseFloat(split.target.needs) / 100;
    const savingsTarget = Number.parseFloat(split.target.savings) / 100;

    const needsOver = split.observed.needs > needsTarget + tolerance;
    const savingShort = split.observed.saved < savingsTarget - tolerance;

    // Needs over target is the structural finding and the only one that earns a
    // warning; a thin savings share with needs in range is information, not a
    // problem with a lever attached.
    const severity: Severity = needsOver ? "warning" : "info";
    const status = needsOver || savingShort ? "action" : "ok";

    // The monthly dollars between where the household is and the target they
    // are furthest from — what the percentage means in money.
    const needsGap = clampAtZero(m(split.needs).sub(m(split.income).mul(needsTarget)));
    const savingsGap = clampAtZero(m(split.income).mul(savingsTarget).sub(m(split.saved)));
    const impact = needsOver ? needsGap : savingShort ? savingsGap : zero();

    const title = needsOver
      ? `Your needs are ${ratioPercent(split.observed.needs)}% of take-home, against a ${targetPercent(split.target.needs)}% target`
      : savingShort
        ? `You are keeping ${ratioPercent(split.observed.saved)}% of take-home, against a ${targetPercent(split.target.savings)}% target`
        : `Your split is ${ratioPercent(split.observed.needs)}/${ratioPercent(split.observed.wants)}/${ratioPercent(split.observed.saved)}, close to your target`;

    const rationale = needsOver
      ? `${m(split.needs).format()} a month of essentials and minimum debt payments against ${m(split.income).format()} of take-home. That is ${needsGap.format()} above the ${targetPercent(split.target.needs)}% line — worth knowing, because it means the room to save is limited by fixed costs rather than by discretionary spending.`
      : savingShort
        ? `${m(split.saved).format()} a month is left after ${m(split.needs).format()} of needs and ${m(split.wants).format()} of wants. Reaching ${targetPercent(split.target.savings)}% would take another ${savingsGap.format()} a month.`
        : `${m(split.needs).format()} of needs, ${m(split.wants).format()} of wants, and ${m(split.saved).format()} kept, against ${m(split.income).format()} of take-home.`;

    return [
      {
        id: recommendationId("needs_wants_split", ""),
        ruleId: "needs_wants_split",
        subjectKey: "",
        severity,
        status,
        title,
        rationale,
        heuristic,
        benchmark: targetPercent(split.target.needs),
        currentValue: ratioPercent(split.observed.needs),
        suggestedValue: targetPercent(split.target.needs),
        impact: impact.toString(),
        inputsUsed: [
          shown(
            "Observed take-home",
            split.income,
            "money",
            `Median of ${split.basisMonths} complete months`,
            "/settings/income",
          ),
          shown(
            "Needs",
            split.needs,
            "money",
            "Essential spend plus minimum debt payments",
            "/settings/categories",
          ),
          shown("Wants", split.wants, "money", "Discretionary spend", "/settings/categories"),
          shown("Kept", split.saved, "money", "Take-home less needs, wants and unclassified spend"),
          split.unclassified === "0.00"
            ? shown("Unclassified spend", "0.00", "money", "Every category is classified")
            : shown(
                "Unclassified spend",
                split.unclassified,
                "money",
                "Subtracted from what was kept, never assumed into needs or wants",
                "/settings/categories",
              ),
          shown(
            "Target split",
            `${targetPercent(split.target.needs)}/${targetPercent(split.target.wants)}/${targetPercent(split.target.savings)}`,
            "text",
            split.targetIsCustom ? "Your household profile" : "The conventional 50/30/20 split",
            "/settings/household",
          ),
        ],
        confidence: baselineConfidence(input),
      },
    ];
  },
};
