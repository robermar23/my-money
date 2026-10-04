import { Money } from "@/lib/money/money.ts";
import { sinkingAvailability } from "@/lib/sinking/availability.ts";
import { SINKING_HORIZON_MONTHS } from "@/lib/sinking/constants.ts";
import { sinkingHorizon, sinkingRequirement } from "@/lib/sinking/requirement.ts";
import { sinkingStatus } from "@/lib/sinking/status.ts";
import type { AdviceInput } from "../snapshot.ts";
import {
  type InputUsed,
  type Recommendation,
  type Rule,
  type Severity,
  recommendationId,
} from "../types.ts";
import { reserveMonthsFor } from "./emergency-fund.ts";
import { baselineConfidence, notRecorded, shown } from "./shared.ts";

/**
 * The sinking-fund rule (Phase 18, PLAN18 P18-20, ADR-046).
 *
 * The heuristic is as conventional as the emergency fund's and almost never
 * applied: **set aside a known irregular cost evenly across the months before it
 * is due.** A household that does it has the March insurance premium in the bank
 * in March; one that does not meets it with a credit card, in the one month it
 * was always going to arrive.
 *
 * This module decides nothing arithmetical. The requirement, the availability
 * and the status are the three pure functions in
 * [src/lib/sinking](../../sinking/requirement.ts), called here over
 * `input.knownFutureCosts` — which is why `/plan/sinking` and this card
 * **cannot** disagree (ADR-046 consequence 1): there is one computation and two
 * renderers of it, not two computations. What is left for the rule is the three
 * judgement calls below.
 *
 * ── Why a real gap can be `info` ───────────────────────────────────────────
 * ADR-046 §3. You do not fund next March's premium ahead of a job-loss reserve,
 * and the ADR-034 §4 waterfall already encodes that order — so the honest way to
 * say it is for this rule to **cap its own severity at `info` while the
 * emergency-fund target is unmet**, and to say why in `rationale`. The
 * alternative was to insert a rung into the shipped ladder, which would amend a
 * locked ADR as a side effect of a new feature. Nothing about the cap suppresses
 * the figure: the gap is reported in full either way. The cap decides only where
 * the card sorts.
 *
 * ── Why an empty cost stream is `unknown_input` ───────────────────────────
 * ADR-046 §5, the sharpest call in the phase, and the one every other rule's
 * trustworthiness depends on. With nothing recorded the arithmetic is clean — a
 * $0 requirement, a known target, a positive surplus — and it reads as *on
 * track*. The app cannot tell *"this household has no large irregular costs"*
 * from *"it has not recorded them yet"*, and on any install the second is
 * overwhelmingly likelier. Telling a family with an unrecorded $1,340 premium
 * that they are fine is the one failure that would make this feature actively
 * harmful. So the rule names the cost list as the missing input and links to
 * where it is entered, exactly as it would for any other input the household has
 * not provided.
 *
 * ── Why `minMonthsHistory: 0` ─────────────────────────────────────────────
 * ADR-046 §6. It reads **recorded costs and recorded balances**, not transaction
 * history — the same argument that puts the APR-based rules at zero. The one
 * input that does need history is the essential baseline, and that degrades
 * through its own named path rather than through a gate that would hide the
 * whole card.
 *
 * ── A note on currency ────────────────────────────────────────────────────
 * `sinkingRequirement` throws rather than add two currencies together
 * (CLAUDE.md §Money — cross-currency arithmetic goes through `fx_rates`, and
 * this phase has no rate lookup), so a household with a foreign-currency planned
 * expense would see this rule fail loudly rather than quietly report a wrong
 * total. Every money column in the phase defaults to the household's currency
 * and nothing in the app writes a second one today; if that ever changes the fix
 * is a conversion in the loader, not a relabelled string here.
 *
 * Pure and I/O-free (ADR-032 §1). Nothing it computes is stored (ADR-032 §3).
 */

/** The practice being implemented, named plainly (ADR-032 §2). */
const HEURISTIC = "Set aside a known irregular cost evenly across the months before it is due";

/** Where a household records a cost, and reads the itemized table. */
const SINKING_HREF = "/plan/sinking";

/** How the reserve tier is built, in the emergency-fund rule's own words. */
const RESERVE_SOURCE = "Balances in accounts with a savings or money-market subtype";

export const sinkingFundRule: Rule = {
  id: "sinking_fund",
  title: "Sinking funds",
  // See the header: recorded costs, recorded balances, no history (ADR-046 §6).
  minMonthsHistory: 0,

  evaluate(input: AdviceInput): Recommendation[] {
    const id = recommendationId("sinking_fund", "");
    const horizon = sinkingHorizon(input.today, input.currency);
    const requirement = sinkingRequirement(input.knownFutureCosts, input.today, horizon);
    const availability = sinkingAvailability(input, requirement);
    const status = sinkingStatus(requirement, availability);
    const reserveTarget = reserveMonthsFor(input);

    const reserveInput = shown(
      "Reserve savings",
      availability.reserveTotal,
      "money",
      RESERVE_SOURCE,
      "/accounts",
    );

    // ── Degradation 1: no essential baseline, so no target (ADR-046 §4) ────
    if (availability.emergencyTarget === null) {
      return [
        {
          id,
          ruleId: "sinking_fund",
          subjectKey: "",
          severity: "info",
          status: "unknown_input",
          title: "We cannot tell you how much to set aside yet",
          rationale:
            "What you can set aside for upcoming costs is the savings you hold above your emergency fund, and sizing that fund needs a figure for your essential monthly expenses. There is not enough classified spending history to compute one yet. Classify a few categories as essential and this fills in.",
          heuristic: HEURISTIC,
          benchmark: null,
          currentValue: null,
          suggestedValue: null,
          impact: null,
          // The cost list is deliberately NOT listed here, even when it is
          // also empty. The audit trail shows what the rule read, and without a
          // target this branch never got as far as needing a requirement to
          // compare — so naming the costs would add a second "fix this" link
          // behind the one that actually unblocks the figure, and a count of
          // `0` presented as a known value is the `null` ≠ `"0.00"` mistake in
          // the audit trail itself.
          inputsUsed: [
            notRecorded(
              "Essential monthly expenses",
              "money",
              "Median monthly spend in categories marked essential, plus minimum debt service",
              "/settings/categories",
            ),
            reserveInput,
          ],
          confidence: "low",
        },
      ];
    }

    const required = Money.fromString(requirement.requiredToday, input.currency);
    const perMonth = Money.fromString(requirement.perMonth, input.currency);
    const available = Money.fromString(availability.available ?? "0.00", input.currency);
    const emergencyTarget = Money.fromString(availability.emergencyTarget, input.currency);
    const reserveTotal = Money.fromString(availability.reserveTotal, input.currency);
    const gap = Money.fromString(availability.gap ?? "0.00", input.currency);

    const targetInput = shown(
      "Emergency-fund target",
      availability.emergencyTarget,
      "money",
      `${reserveTarget.months} months of essential expenses, held before anything is set aside for a dated cost`,
      "/settings/household",
    );
    const baselineInput = shown(
      "Essential monthly expenses",
      input.essentials.baseline ?? "0.00",
      "money",
      `Median of ${input.essentials.basisMonths} months of essential spend, plus ${input.essentials.minimumDebtService} of minimum debt service`,
      "/settings/categories",
    );
    const monthsInput = shown(
      "Reserve target",
      `${reserveTarget.months}`,
      "months",
      reserveTarget.reason,
      "/settings/household",
    );

    // ── Degradation 2: nothing recorded to require (ADR-046 §5) ────────────
    if (status === "no_costs_recorded") {
      return [
        {
          id,
          ruleId: "sinking_fund",
          subjectKey: "",
          severity: "info",
          status: "unknown_input",
          title: "Record the costs you already know are coming",
          rationale: `You have ${available.format()} in savings above your ${emergencyTarget.format()} emergency-fund target, and nothing recorded for it to cover. That is not the same as having no large irregular costs — insurance premiums, property taxes, a car service, a dental bill — so this stays unanswered rather than reporting that you are on track. Record what you know is coming and this becomes a figure.`,
          heuristic: HEURISTIC,
          benchmark: null,
          currentValue: null,
          suggestedValue: null,
          impact: null,
          inputsUsed: [
            notRecorded(
              "Known upcoming costs",
              "count",
              `No costs recorded between ${requirement.horizonFrom} and ${requirement.horizonTo}`,
              SINKING_HREF,
            ),
            reserveInput,
            targetInput,
            baselineInput,
            monthsInput,
          ],
          confidence: "low",
        },
      ];
    }

    const inputsUsed: InputUsed[] = [
      shown(
        "Set aside required today",
        requirement.requiredToday,
        "money",
        `${requirement.costCount} known costs due in the next ${SINKING_HORIZON_MONTHS} months`,
        SINKING_HREF,
      ),
      reserveInput,
      targetInput,
      shown(
        "Reserve above your emergency-fund target",
        availability.available ?? "0.00",
        "money",
        "Reserve savings minus the emergency-fund target — one pot cannot do both jobs",
        "/accounts",
      ),
      baselineInput,
      monthsInput,
    ];

    // The baseline's own honesty is what the target rests on, so the shipped
    // grader decides this rather than a threshold invented here (ADR-046 §7).
    const confidence = baselineConfidence(input);
    const pastDue =
      requirement.pastDueCount === 0
        ? ""
        : ` ${requirement.pastDueCount} of them ${requirement.pastDueCount === 1 ? "is" : "are"} already past due — mark ${requirement.pastDueCount === 1 ? "it" : "them"} paid or move the date, or the figure above keeps counting ${requirement.pastDueCount === 1 ? "it" : "them"} in full.`;
    const stream = `Across your ${requirement.costCount} known costs due in the next ${SINKING_HORIZON_MONTHS} months, that is ${perMonth.format()} a month.`;

    // `sinkingStatus` says the figures can be STATED, not that they are good
    // news — a $1,580 gap is `"ok"` to it. Whether the household is *there* is
    // the gap's question, and it is asked separately so the two meanings of the
    // word cannot be quietly swapped.
    if (gap.isZero()) {
      return [
        {
          id,
          ruleId: "sinking_fund",
          subjectKey: "",
          severity: "info",
          status: "ok",
          title: `Your savings cover the ${required.format()} your known costs need`,
          rationale: `You hold ${available.format()} above your ${emergencyTarget.format()} emergency-fund target, against ${required.format()} that should already be set aside for costs you know are coming. ${stream}${pastDue}`,
          heuristic: HEURISTIC,
          benchmark: requirement.requiredToday,
          currentValue: available.toString(),
          suggestedValue: requirement.requiredToday,
          impact: "0.00",
          inputsUsed,
          confidence,
        },
      ];
    }

    // ADR-046 §3. Funded reserve → this is the next real job for a dollar.
    // Short reserve → the emergency fund is the more urgent problem and the
    // rationale says so, rather than two cards competing over the same dollars.
    const reserveFunded = !reserveTotal.sub(emergencyTarget).isNegative();
    const severity: Severity = reserveFunded ? "warning" : "info";
    const ordering = reserveFunded
      ? "Your emergency fund is already at its target, so these are the next dollars with a job."
      : `Your emergency fund comes first: it is ${reserveTotal.format()} of its ${emergencyTarget.format()} target, so treat this as the queue behind it rather than something to fund instead.`;

    return [
      {
        id,
        ruleId: "sinking_fund",
        subjectKey: "",
        severity,
        status: "action",
        title: `Set aside ${gap.format()} more for costs you already know about`,
        rationale: `${required.format()} should already be set aside for your known upcoming costs, and you hold ${available.format()} above your emergency-fund target — a ${gap.format()} shortfall. ${stream} ${ordering}${pastDue}`,
        heuristic: HEURISTIC,
        benchmark: requirement.requiredToday,
        currentValue: available.toString(),
        suggestedValue: requirement.requiredToday,
        impact: availability.gap,
        inputsUsed,
        confidence,
      },
    ];
  },
};
