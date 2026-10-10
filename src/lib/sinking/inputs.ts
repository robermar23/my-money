import { reserveMonthsFor } from "@/lib/advice/rules/emergency-fund.ts";
import { notRecorded, shown } from "@/lib/advice/rules/shared.ts";
import type { AdviceInput } from "@/lib/advice/snapshot.ts";
import { SINKING_HORIZON_MONTHS } from "./constants.ts";
import { sinkingStatus } from "./status.ts";
import type { InputUsed, SinkingAvailability, SinkingRequirement } from "./types.ts";

/**
 * The sinking fund's audit trail, built once (P18-22, ADR-032 §2, ADR-046
 * consequence 1).
 *
 * ── Why this is not inline in the rule ────────────────────────────────────
 * ADR-046 consequence 1 says `/plan/sinking` and the guidance card **cannot**
 * disagree, and the figures already could not: both call the same
 * [requirement](./requirement.ts) and [availability](./availability.ts). The
 * `inputsUsed` list was the one part each would have written for itself, and a
 * divergence there is the quieter of the two failures — the page and the card
 * would agree that $2,180 is required and disagree about **where it came
 * from**, which is exactly the question a reader opens the audit trail to ask.
 * One function, two call sites, and [inputs.test.ts](./inputs.test.ts) asserts
 * the two get the same list in all three branches.
 *
 * ── Three branches, keyed on the shipped ladder ───────────────────────────
 * The list is a function of what could be computed, so it asks
 * {@link sinkingStatus} rather than re-deriving the same conditions from
 * `null` checks. The branches differ in what they are allowed to claim:
 *
 *   `no_baseline`       — two inputs. The cost list is deliberately absent even
 *     when it is also empty: without a target this branch never got as far as
 *     needing a requirement, so naming the costs would add a second "fix this"
 *     link behind the one that actually unblocks the figure — and a count of
 *     `0` shown as a known value is the `null` ≠ `"0.00"` mistake moved into
 *     the audit trail itself.
 *   `no_costs_recorded` — the cost list named as **missing**, with the horizon
 *     it looked at, plus the four inputs that did resolve. The surrounding
 *     figures are real and are shown; what is unknown is the requirement.
 *   `ok`                — all six, ordered the way a reader checks them: the
 *     requirement, then what is held, then what is reserved against it, then
 *     the two inputs that sized the reserve.
 *
 * Pure and I/O-free. Every money value is a `numeric(18,2)` string, passed
 * through unformatted — the renderer formats (CLAUDE.md §Money).
 */

/** Where a household records a cost, and reads the itemized table. */
export const SINKING_HREF = "/plan/sinking";

/** How the reserve tier is built, in the emergency-fund rule's own words. */
const RESERVE_SOURCE = "Balances in accounts with a savings or money-market subtype";

/** How the essential baseline is derived, for the branch that cannot read one. */
const BASELINE_SOURCE =
  "Median monthly spend in categories marked essential, plus minimum debt service";

/**
 * Where a household fixes a missing essential baseline.
 *
 * `/settings/categories`, not `/settings/household`, which is what PLAN18's
 * P18-20 list said. You fix a baseline by classifying categories as essential,
 * and the shipped emergency-fund rule already sends the same input to the same
 * place — two hrefs for one input on two cards is the drift `reserveMonthsFor`
 * is exported to prevent. `/settings/household` carries the reserve-months
 * target, which is a different input and is linked there.
 */
const BASELINE_HREF = "/settings/categories";

/**
 * Build the audit trail behind a sinking-fund figure.
 *
 * @param input - The assembled snapshot. Read for `essentials`, `cash` and
 *   whatever `reserveMonthsFor` consults. Never mutated.
 * @param requirement - The output of {@link ./requirement.ts sinkingRequirement}.
 * @param availability - The output of
 *   {@link ./availability.ts sinkingAvailability}.
 * @returns The inputs behind the figure, in reading order. Never empty.
 */
export function sinkingInputsUsed(
  input: AdviceInput,
  requirement: SinkingRequirement,
  availability: SinkingAvailability,
): readonly InputUsed[] {
  const reserveTarget = reserveMonthsFor(input);
  const reserveInput = shown(
    "Reserve savings",
    availability.reserveTotal,
    "money",
    RESERVE_SOURCE,
    "/accounts",
  );

  if (availability.emergencyTarget === null) {
    return [
      notRecorded("Essential monthly expenses", "money", BASELINE_SOURCE, BASELINE_HREF),
      reserveInput,
    ];
  }

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
    BASELINE_HREF,
  );
  const monthsInput = shown(
    "Reserve target",
    `${reserveTarget.months}`,
    "months",
    reserveTarget.reason,
    "/settings/household",
  );

  if (sinkingStatus(requirement, availability) === "no_costs_recorded") {
    return [
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
    ];
  }

  return [
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
}
