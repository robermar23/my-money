/**
 * Checked-in sinking-fund constants (Phase 18, ADR-045 §5, P18-11).
 *
 * Same posture as [cashflow/constants.ts](../cashflow/constants.ts) and
 * [advice/constants.ts](../advice/constants.ts): the numbers this feature's
 * arithmetic depends on live in the repository, reviewable in a diff, rather
 * than in a settings row where they would quietly stop tracking the constant.
 *
 * Nothing here is fetched and nothing here is user data.
 */

/**
 * How far ahead the requirement looks (ADR-045 §5).
 *
 * Twelve months, because Round 12 asked *"how much should I have set aside for
 * the four known costs in the next 12 months"* and because a longer horizon
 * accrues today for costs the household cannot yet size. It is a **hard edge**,
 * and that is disclosed rather than smoothed: a cost thirteen months out
 * contributes nothing today and appears next month at a full month's accrual.
 * Softening it would mean accruing a fraction of a cost whose amount is a guess.
 */
export const SINKING_HORIZON_MONTHS = 12;

/**
 * How far ahead obligation occurrences are materialized for the cadences a
 * sinking fund accrues for (P18-11, ADR-045 consequence 2).
 *
 * ── Why this constant exists at all ───────────────────────────────────────
 * The requirement reads **materialized occurrence rows** rather than re-expanding
 * schedules, deliberately: two answers to "when is this due" is how they drift
 * (ADR-045, rejected alternatives). The consequence is that the stream can only
 * see as far as the materializer has written. The cash-flow materializer runs to
 * `today + projection_horizon_days + MATERIALIZATION_LEAD_DAYS` — **about 90
 * days at the shipped defaults** — against a 365-day sinking horizon. Without a
 * change, every annual and semiannual occurrence beyond those 90 days simply
 * does not exist as a row, and the requirement is **silently understated**: the
 * page reports a confident, too-small number and nothing anywhere is red.
 *
 * ── Why 400 days ──────────────────────────────────────────────────────────
 * 366 is the longest a twelve-month horizon can be. The extra month of slack is
 * for the gap between nightly runs: at exactly 366 the far edge of the horizon
 * would be covered on the day it was materialized and uncovered the next
 * morning, so a cost would flicker in and out of the requirement with the job
 * schedule. Rounded to 400 rather than 396 because the precision is meaningless
 * — it is "thirteen months, comfortably" — and a round number invites fewer
 * attempts to tune it.
 *
 * ── Why the extra rows are affordable ─────────────────────────────────────
 * Only the eligible cadences get the longer lead ({@link
 * materializationDaysAhead}), so the growth is bounded and small: an annual
 * obligation holds 2 future rows instead of 1, a semiannual 3 instead of 1, a
 * quarterly 5 instead of 2. A weekly bill — which would be 56 rows nobody reads
 * — keeps the cash-flow lead untouched. Materialization is
 * `ON CONFLICT (obligation_id, due_date) DO NOTHING`, so widening the lead adds
 * only the tail and re-running is a no-op.
 */
export const SINKING_MATERIALIZATION_DAYS_AHEAD = 400;
