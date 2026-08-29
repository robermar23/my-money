import type { InputUsed, ProjectionStatus } from "./types.ts";

/**
 * The four-level degradation ladder (P16-19, ADR-038 §7).
 *
 * Pure. Decides how much of the projection can be stated honestly, and — when
 * the answer is "less than all of it" — NAMES the input that is missing and
 * links to where the user supplies it.
 *
 * ── Degrading is the normal path, not the error path ───────────────────────
 * On a fresh install, three of these four levels are the correct answer. A
 * household that has just imported one statement and confirmed no obligations
 * is not in an error state; it is at the beginning. The UI renders these as
 * plainly as it renders a number, which is the standard ADR-021 set for
 * `insufficient_history` and ADR-034 §7 generalized for advice. What is NOT
 * acceptable is a projection that quietly fills a missing input with a guess.
 *
 * ── The ladder is ordered, and the order is the point ──────────────────────
 * A household with no classified operating account also has no useful history
 * and no confirmed obligations — all three checks fire. Reporting the LAST of
 * them would send the user to a candidate-review page that cannot help until
 * there is an account to project from. So the most fundamental missing input
 * wins, and each level's fix is the thing that unblocks the next one:
 *
 *     no operating account  →  classify one            (/accounts)
 *     under 3 months        →  import more history     (/accounts)
 *     no obligations        →  confirm candidates      (/plan/cashflow/review)
 *     otherwise             →  ok
 *
 * ── Thin coverage is deliberately NOT a fifth level ────────────────────────
 * A projection with 30% coverage is still the best available answer, and
 * suppressing it would be worse than qualifying it. Coverage travels as a
 * percentage shown BESIDE an `ok` figure (ADR-038 §7), which is why it is not a
 * parameter here.
 *
 * ── Why the missing input is an `InputUsed` ────────────────────────────────
 * ADR-038 §8: the projection reuses the advice layer's audit shape rather than
 * inventing a parallel one. `value: null` says "not recorded", which the UI
 * already renders differently from `"0"` — and that distinction is exactly what
 * "no operating account" needs to say.
 */

/** Months of transaction history below which no residual rate is honest. */
export const MIN_HISTORY_MONTHS = 3;

/**
 * The rungs a safe-to-spend figure may be stated from.
 *
 * One list, three readers: the alert mapper decides whether to interrupt the
 * household from it, `/plan/cashflow` decides whether to print the headline from
 * it, and the dashboard card decides whether to show a figure at all. They must
 * agree — a number worth waking someone at 02:00 for is a number worth printing,
 * and a number too thin to print is certainly too thin to alert on.
 *
 * `insufficient_history` is excluded even though a projection technically exists
 * for it: the loader zeroes the discretionary rate at that rung because there is
 * no honest one, so any figure derived from it assumes the household spends
 * nothing day to day. That INFLATES safe-to-spend, and ADR-038 §5 names
 * inflation as the dangerous direction. The dated calendar still renders — a
 * schedule is not a forecast, and the two surfaces say which one is on screen.
 */
export const STATED_FIGURE_STATUSES: readonly ProjectionStatus[] = ["ok", "run_rate_only"];

/** The counts the ladder reads. Every one of them is a fact, not a judgement. */
export interface StatusInput {
  /** Accounts classified `checking` / `cash_management` (ADR-033 §1). */
  readonly operatingAccountCount: number;
  /** Months of transaction history available for the trailing window. */
  readonly historyMonths: number;
  /** CONFIRMED obligations — candidates do not count (ADR-036 §2). */
  readonly confirmedObligationCount: number;
  /** Detected candidates awaiting review. Drives the run-rate-only fix link. */
  readonly candidateCount: number;
}

/** The status and, unless `ok`, the one input that is blocking it. */
export interface ProjectionStatusResult {
  readonly status: ProjectionStatus;
  /** `null` only when `status === 'ok'`. */
  readonly missing: InputUsed | null;
}

/**
 * Decide how honestly the projection can be stated.
 *
 * @param input - The four counts. All must be non-negative.
 * @returns The status, plus the named and linked missing input when not `ok`.
 * @throws If any count is negative — a negative count is an upstream bug, and
 *   degrading gracefully on nonsense would hide it behind a plausible screen.
 */
export function projectionStatus(input: StatusInput): ProjectionStatusResult {
  assertNonNegative("operatingAccountCount", input.operatingAccountCount);
  assertNonNegative("historyMonths", input.historyMonths);
  assertNonNegative("confirmedObligationCount", input.confirmedObligationCount);
  assertNonNegative("candidateCount", input.candidateCount);

  if (input.operatingAccountCount === 0) {
    return {
      status: "no_operating_account",
      missing: {
        label: "Operating cash account",
        // null, not "0": the subtype is NOT RECORDED. The user may well have a
        // checking account — it just has not been classified as one.
        value: null,
        kind: "count",
        source: "Accounts with a checking or cash-management subtype",
        missing: true,
        href: "/accounts",
      },
    };
  }

  if (input.historyMonths < MIN_HISTORY_MONTHS) {
    return {
      status: "insufficient_history",
      missing: {
        label: "Months of transaction history",
        value: String(input.historyMonths),
        kind: "months",
        source: `A spending rate needs at least ${MIN_HISTORY_MONTHS} months`,
        missing: true,
        // Import lives under an account (`/accounts/[id]/import`), so the
        // account list is the honest starting point.
        href: "/accounts",
      },
    };
  }

  if (input.confirmedObligationCount === 0) {
    return {
      status: "run_rate_only",
      missing: {
        label: "Confirmed recurring obligations",
        value: String(input.candidateCount),
        kind: "count",
        source:
          input.candidateCount > 0
            ? `${input.candidateCount} detected and waiting for review`
            : "None detected yet",
        missing: true,
        href: "/plan/cashflow/review",
      },
    };
  }

  return { status: "ok", missing: null };
}

function assertNonNegative(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`projectionStatus: ${field} cannot be negative, got ${value}`);
  }
}
