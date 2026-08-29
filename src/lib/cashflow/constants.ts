/**
 * Checked-in cash-flow defaults (Phase 16, ADR-037 §4 / ADR-038 §4/§5).
 *
 * Same posture as [advice/constants.ts](../advice/constants.ts): the numbers the
 * projection falls back to live in the repository, reviewable in a diff, rather
 * than being pinned into the database on install day where they would quietly
 * stop tracking the constant. Every corresponding `household_profile` column is
 * NULLABLE, and NULL means "use the value here".
 *
 * Nothing in this module is fetched, and nothing here is user data.
 */

/**
 * How far the daily balance projection runs when the user has stated no
 * preference.
 *
 * Long enough to contain a full pay cycle plus a monthly bill cycle plus the
 * next one — the window a family can still *act* in. Beyond roughly 90 days the
 * residual discretionary rate dominates the line and it stops being information,
 * which is why the settings CHECK bounds the override at 365 as a guard rail
 * rather than as an endorsement.
 */
export const DEFAULT_PROJECTION_HORIZON_DAYS = 60;

/**
 * The buffer safe-to-spend subtracts when the user has stated none.
 *
 * Zero, deliberately. A default cushion would silently reduce a number the
 * household acts on by an amount nobody chose, and the figure is always
 * displayed alongside its floor precisely so the user can see it is theirs.
 */
export const DEFAULT_CASH_FLOOR = "0.00";

/**
 * How far ahead occurrences are materialized, relative to the horizon.
 *
 * A little past the horizon so the calendar never runs out mid-projection
 * between nightly runs, and so extending the horizon by a few days does not
 * require a re-materialization before the line can be drawn.
 */
export const MATERIALIZATION_LEAD_DAYS = 30;
