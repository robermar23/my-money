import type { Job } from "bullmq";
import {
  type MaterializeContributionsOptions,
  type MaterializeContributionsResult,
  materializeContributions,
} from "./materialize-contributions.ts";

/**
 * P14-11 (ADR-031 §3) — run-once historical contribution backfill.
 *
 * The nightly job (P14-09) only looks back far enough to survive an outage. A
 * newly-defined paycheck, though, usually describes years of real contributions
 * that already happened, and the 401k's cost basis is only correct once those
 * are on the books. This walks each active source from its `start_date` to
 * today and materializes every pay date in between.
 *
 * Deliberately a thin wrapper: it is the SAME code path as the nightly run,
 * only with a wider window. Anything else risks the backfill and the nightly
 * job disagreeing about what a contribution is — the exact bug that would make
 * historical basis differ from ongoing basis.
 *
 * Safe to run repeatedly. Idempotency is the UNIQUE `(rule, pay_date)` key, so
 * a second pass writes nothing; it can also run while the nightly job is
 * scheduled without coordination.
 *
 * Honest about prices (ADR-031 §3): dates with a close in `prices` buy shares at
 * that close; dates older than our price history record dollars only. The
 * planner degrades per pay date, so one backfill can (and typically does) span
 * both — basis-only for the early years, real share lots once history begins.
 *
 * Afterwards, the nightly `compute-snapshots-daily` picks up the new lots and
 * quantities for `holding_snapshots` with no change to that job. Historical
 * snapshots are NOT retroactively rewritten here; use the existing
 * `backfill-holding-snapshots` run-once for that.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/worker/run-once.ts backfill-contributions
 */

/**
 * A floor old enough to predate any real paycheck. The planner intersects the
 * window with each source's own `start_date`, so this never widens what a
 * source claims — it just declines to impose a second, arbitrary bound.
 */
const EPOCH_FLOOR = "1970-01-01";

/**
 * Materialize every historical contribution from each source's start to today.
 *
 * @param _job - Unused; present so this can be enqueued as a BullMQ job.
 * @param options - Test seams (clock, price lookup, window end).
 * @returns Counts of rules considered and contributions written.
 */
export async function backfillContributionsProcessor(
  _job?: Job,
  options: MaterializeContributionsOptions = {},
): Promise<MaterializeContributionsResult> {
  return materializeContributions({ ...options, from: options.from ?? EPOCH_FLOOR });
}
