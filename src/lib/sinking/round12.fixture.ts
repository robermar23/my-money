import type { AdviceInputOverrides } from "@/lib/advice/advice-input.fixture.ts";
import { makeAdviceInput, makeCash } from "@/lib/advice/advice-input.fixture.ts";
import type { AdviceInput } from "@/lib/advice/snapshot.ts";
import type { KnownFutureCost } from "./types.ts";

/**
 * Round 12's own example, as a fixture (P18-16).
 *
 * [PLAN18.md](../../../plans/features/PLAN18.md) states the deliverable as one
 * sentence:
 *
 * > ***"You should be holding $2,180 against the four known costs in the next 12
 * > months. Your reserve above your emergency-fund target is $600."***
 *
 * This module is that sentence's inputs, so the claim is a **test** rather than
 * a paragraph. [requirement.test.ts](./requirement.test.ts) asserts the $2,180
 * and [availability.test.ts](./availability.test.ts) asserts the $600, both
 * against string literals typed out by hand — the fixture deliberately exports
 * no expected total, because a test that asserts a figure imported from its own
 * fixture asserts nothing.
 *
 * ── Why the numbers are the shape they are ────────────────────────────────
 * Every amount here divides evenly by its own month count, so each
 * `requiredToday` is exact to the cent and the four of them add to a round
 * $2,180. That is a convenience for the reader, not a property of the
 * arithmetic: [accrual.test.ts](./accrual.test.ts) is where the awkward
 * divisions live (Round 12's real $1,340 over 7 months, which is where the
 * one-division rule earns its keep). Here the point is the **total**, and a
 * total nobody can verify by hand proves nothing.
 *
 * The stream spans **both sources on purpose** — two `planned_expense` rows and
 * two `obligation` rows, with the car insurance among the obligations. That is
 * ADR-045's whole argument in a fixture: a requirement built from
 * `planned_expenses` alone would omit the annual premium the round opens with,
 * and would total $1,200 instead of $2,180.
 *
 * **Test-only module.** Nothing in `src/app`, `src/worker` or `src/lib` outside
 * a `*.test.ts` may import it — the same rule, for the same reason, as
 * [advice-input.fixture.ts](../advice/advice-input.fixture.ts). It lives outside
 * a test file only because several test files share it.
 */

/** The evaluation date every figure here is stated as of. */
export const ROUND12_TODAY = "2026-10-04";

/** Twelve months from {@link ROUND12_TODAY} (ADR-045 §5). */
export const ROUND12_HORIZON = {
  from: ROUND12_TODAY,
  to: "2027-10-04",
  currency: "USD",
} as const;

/**
 * The four known costs, in the stream's deterministic `(dueDate, label, id)`
 * order.
 *
 * Accruals as of {@link ROUND12_TODAY}, every one exact:
 *
 * | Cost | Amount | Term | Elapsed | Per month | Required today |
 * |---|---|---|---|---|---|
 * | Water bill (quarterly obligation) | $240 | 3 | 1 | $80 | $80 |
 * | Car insurance (annual obligation) | $1,200 | 12 | 9 | $100 | $900 |
 * | Dental work (planned expense) | $1,800 | 6 | 2 | $300 | $600 |
 * | Roof repair (planned expense) | $1,800 | 18 | 6 | $100 | $600 |
 * | **Total** | | | | **$580** | **$2,180** |
 *
 * The roof is due on the horizon's **last day**, which is inside it — so this
 * fixture also exercises the inclusive upper edge every time it is used.
 *
 * @returns A fresh array, so a test that sorts or splices it cannot affect
 *   another test.
 */
export function round12Costs(): readonly KnownFutureCost[] {
  return [
    {
      source: "obligation",
      sourceId: "occ-water",
      label: "Water bill",
      amount: "240.00",
      currency: "USD",
      dueDate: "2026-12-04",
      // The previous quarterly occurrence (ADR-045 §3).
      fundingStart: "2026-09-04",
      status: "planned",
      categoryId: null,
    },
    {
      source: "obligation",
      sourceId: "occ-insurance",
      label: "Car insurance",
      amount: "1200.00",
      currency: "USD",
      dueDate: "2027-01-04",
      // Last year's premium: you have had the whole year to save for this one.
      fundingStart: "2026-01-04",
      status: "planned",
      categoryId: null,
    },
    {
      source: "planned_expense",
      sourceId: "pe-dental",
      label: "Dental work",
      amount: "1800.00",
      currency: "USD",
      dueDate: "2027-02-04",
      fundingStart: "2026-08-04",
      status: "planned",
      categoryId: null,
    },
    {
      source: "planned_expense",
      sourceId: "pe-roof",
      label: "Roof repair",
      amount: "1800.00",
      currency: "USD",
      dueDate: "2027-10-04",
      fundingStart: "2026-04-04",
      status: "planned",
      categoryId: null,
    },
  ];
}

/**
 * The household Round 12 describes: $3,000/month of essentials, a $9,600
 * reserve, and therefore **$600 above** a 3-month emergency-fund target.
 *
 * The reserve is one savings account rather than a hand-written
 * {@link makeCash} rollup, so the figure {@link sinkingAvailability} reads comes
 * out of the shipped `classifyCashTiers` — ADR-046 §2's "reserve tier only",
 * classified by the one classifier rather than asserted by a fixture.
 *
 * No `reserve_months_override` and no dependents, so `reserveMonthsFor` returns
 * the default 3 and the target is $9,000. A test that needs 6 months passes a
 * profile override and gets a $18,000 target, which is how the "available
 * clamps at zero" case is built.
 *
 * @param overrides - Anything the calling test is actually about.
 * @returns A complete snapshot in `loadFinancialSnapshot`'s shape.
 */
export function round12Input(overrides: AdviceInputOverrides = {}): AdviceInput {
  // `in` rather than `??`, so a test that overrides the baseline to `null` gets
  // a reserve tier whose `monthsCovered` is honestly unknown instead of one
  // silently classified against the default $3,000.
  const baseline =
    overrides.essentials && "baseline" in overrides.essentials
      ? (overrides.essentials.baseline ?? null)
      : "3000.00";

  return makeAdviceInput({
    today: ROUND12_TODAY,
    cash: makeCash([{ name: "Ally Savings", subtype: "savings", balance: "9600.00" }], baseline),
    ...overrides,
  });
}
