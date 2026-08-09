import { type SQL, sql } from "drizzle-orm";

/**
 * Banker's rounding to cents, expressed in SQL.
 *
 * ## Why this exists
 *
 * [money.ts](../money/money.ts) configures decimal.js globally with
 * `ROUND_HALF_EVEN` (banker's rounding, the GAAP default), so every
 * `Decimal.toFixed(2)` in the app rounds half-to-even. **Postgres `round(numeric, 2)`
 * rounds half-away-from-zero.** The two agree on every value except an exact
 * half-cent tie — and ties are reachable in ordinary data:
 *
 * ```text
 *   0.5 shares × $100.01  =  50.005
 *     decimal.js half-even → 50.00        Postgres round() → 50.01
 * ```
 *
 * Any SQL that reproduces a figure TypeScript used to compute must therefore
 * round the same way, or the two drift by a cent on tie values. This module is
 * the single place that rule is written down, so it can be unit-tested against
 * decimal.js directly ([round.test.ts](./round.test.ts)) rather than rediscovered
 * per query.
 *
 * ## The algorithm
 *
 * Work in cents (`x × 100`). A tie is exactly `|cents − trunc(cents)| = 0.5`.
 *   - **Tie** → keep `trunc(cents)` when it is even, otherwise step one away from
 *     zero. (`sign` is never 0 in the tie branch: a tie implies `cents ≠ 0`.)
 *   - **Not a tie** → plain `round()`, which agrees with half-even whenever there
 *     is nothing to break.
 *
 * Negatives fall out of the same expression because Postgres `trunc` truncates
 * toward zero and `%` keeps the dividend's sign: `-50.015 → trunc(-5001.5) =
 * -5001`, `-5001 % 2 = -1` (odd) `→ -5001 + sign(-1) = -5002 → -50.02`, which is
 * what `Money.fromString("-50.015").toString()` returns.
 *
 * ## The one known difference: negative zero
 *
 * decimal.js keeps a signed zero, so `new Decimal("-0.004").toFixed(2)` is the
 * string `"-0.00"`. Postgres `numeric` has no negative zero and yields `0.00`.
 * This is representational only and cannot reach a displayed figure: that string
 * is transient — `valueHolding` hands it straight back to `Money.fromString`,
 * and `Money.toString()` renders any exact zero as `"0.00"` regardless of its
 * internal sign. The difference is asserted (not papered over) in
 * `round.test.ts`.
 */

/**
 * Round a numeric SQL expression to 2 decimal places using half-even (banker's)
 * rounding, matching decimal.js `toFixed(2)` under this app's global config.
 *
 * @param value - A numeric-typed SQL expression. Prefer passing a column
 *   reference (or a CTE column) rather than a large expression: the fragment
 *   mentions it five times, and Postgres will evaluate it that many times.
 * @returns A `numeric` SQL expression, exact to the cent.
 */
export function halfEvenCents(value: SQL): SQL {
  const cents = sql`(${value} * 100)`;
  return sql`((CASE
      WHEN abs(${cents} - trunc(${cents})) = 0.5
        THEN trunc(${cents}) + CASE WHEN trunc(${cents}) % 2 = 0 THEN 0 ELSE sign(${cents}) END
      ELSE round(${cents})
    END) / 100)`;
}
