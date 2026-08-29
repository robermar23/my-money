import type { IncomeCadence } from "@/db/schema/income-sources.ts";

/**
 * The obligation cadence vocabulary (P16-01, ADR-037 §3).
 *
 * A scheduled obligation repeats on a wider set of cadences than a paycheck
 * does: insurance premiums land semiannually, estimated taxes quarterly,
 * property tax and domain renewals annually. `income_sources.cadence` stays
 * exactly the four it has always been — its CHECK is NOT widened, and
 * `periodsPerYear` in [income/schedule.ts](../income/schedule.ts) keeps its
 * four-member map (see the warning there).
 *
 * The two vocabularies are separate `const` tuples rather than one shared list,
 * because they are genuinely different domains that happen to overlap. What
 * keeps them from drifting is the compile-time assertion below: obligations must
 * always be able to express anything income can, since both are expanded by the
 * same `occurrenceDatesBetween` (ADR-036 §5).
 *
 * `IncomeCadence` is imported as a TYPE ONLY, so this module pulls no Drizzle
 * table code — the same reasoning as [schemas/income.ts](../schemas/income.ts).
 */
export const OBLIGATION_CADENCES = [
  "weekly",
  "biweekly",
  "semimonthly",
  "monthly",
  "quarterly",
  "semiannual",
  "annual",
] as const;

/** How often a scheduled obligation recurs (mirrors the ADR-037 §1 CHECK). */
export type ObligationCadence = (typeof OBLIGATION_CADENCES)[number];

/**
 * Compile-time proof that a type is assignable to another, evaluating to the
 * narrow type itself. The `extends` constraint is the assertion: if `Narrow` is
 * not assignable to `Wide`, this fails to instantiate and `tsc` errors.
 */
type AssertAssignable<Narrow extends Wide, Wide> = Narrow;

/**
 * ADR-037 §3, enforced by the compiler: every income cadence is also an
 * obligation cadence.
 *
 * Adding a member to `INCOME_CADENCES` without adding it to
 * `OBLIGATION_CADENCES` breaks the build here rather than silently producing an
 * income source that `occurrenceDatesBetween` cannot expand. Exported so it is
 * a real declaration rather than dead code Biome would strip.
 */
export type IncomeCadenceIsObligationCadence = AssertAssignable<IncomeCadence, ObligationCadence>;
