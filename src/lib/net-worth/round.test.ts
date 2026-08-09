import { db } from "@/db/client.ts";
import { Money } from "@/lib/money/money.ts";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { halfEvenCents } from "./round.ts";

/**
 * Integration test for the half-even SQL fragment (NW-01).
 *
 * This is the one place where a Postgres expression and decimal.js have to agree
 * digit-for-digit, so the test asserts it directly rather than inferring it from
 * a higher-level parity check: for a table of values — deliberately loaded with
 * exact half-cent ties, where Postgres' native `round()` and decimal.js diverge —
 * the SQL result must equal what the app's own money rounding produces.
 *
 * The oracle is deliberately `Money.toString()` rather than a bare
 * `new Decimal(v).toFixed(2)`: **decimal.js's half-even mode is a side effect of
 * importing [money.ts](../money/money.ts)** (`Decimal.set({ rounding })` at module
 * scope). A test that imported only `decimal.js` would silently compare against
 * the library default (half-*up*) and "prove" the wrong contract. Going through
 * `Money` is both correct and the exact call the production path makes.
 *
 * Read-only: it touches no table, so it needs no truncation or fixtures.
 */

/** Values that a naive `round(x, 2)` would get wrong, plus ordinary controls. */
const CASES: readonly string[] = [
  // ── exact ties: round-half-even keeps the even cent ────────────────────────
  "50.005", // → 50.00  (Postgres round() would say 50.01)
  "-50.005", // → -50.00
  "50.015", // → 50.02
  "-50.015", // → -50.02
  "0.005", // → 0.00   (zero is even)
  "-0.005", // → -0.00 → "0.00"
  "0.015", // → 0.02
  "2.675", // the classic float-error example; exact in decimal → 2.68
  "1.005", // → 1.00
  "1.015", // → 1.02
  "123456.785", // → 123456.78
  "-123456.785", // → -123456.78
  // ── non-ties: both modes agree, but the fragment must not disturb them ─────
  "50.004",
  "50.006",
  "-50.004",
  "-50.006",
  "0",
  "100",
  "-100",
  "0.001",
  "-0.001",
  "9999999999.999",
  "0.5", // a half at a place we are NOT rounding to
  "1.5",
  "-1.5",
  // ── realistic products: quantity × close, the way the series query builds it ─
  "50.005000", // 0.5 shares × 100.01
  "12345.67890123",
  "-12345.67890123",
];

/**
 * Postgres `numeric` has no signed zero; decimal.js does. See `round.ts`
 * §"The one known difference" — this normalizes the oracle so the rest of the
 * table is compared strictly, and the difference gets its own test below.
 */
function withoutNegativeZero(value: string): string {
  return value === "-0.00" ? "0.00" : value;
}

describe("halfEvenCents", () => {
  it("matches decimal.js toFixed(2) for ties, non-ties, and signs", async () => {
    // One round-trip for the whole table: each case becomes a row of a VALUES
    // list so the fragment is exercised as an expression over a column, exactly
    // as the series query uses it.
    const values = sql.join(
      CASES.map((v) => sql`(${v}::numeric)`),
      sql`, `,
    );
    const rows = await db.execute<{ input: string; rounded: string }>(
      sql`SELECT v::text AS input, ${halfEvenCents(sql`v`)}::text AS rounded
          FROM (VALUES ${values}) AS t(v)`,
    );

    const results = [...rows];
    expect(results).toHaveLength(CASES.length);

    for (const row of results) {
      const expected = withoutNegativeZero(Money.fromString(row.input, "USD").toString());
      const actual = new Decimal(row.rounded);
      // Two assertions, because equality alone is not enough: an unrounded
      // 50.005 would still pass `toFixed(2)`-normalized equality. The value must
      // ALSO already be exact at the cent when it leaves Postgres.
      expect(actual.dp(), `${row.input} was not rounded to cents`).toBeLessThanOrEqual(2);
      expect(actual.toFixed(2), `${row.input}`).toBe(expected);
    }
  });

  it("differs from Postgres round() exactly on the tie cases", async () => {
    // Guards the premise. If a future Postgres made round() half-even, or a
    // future decimal.js config made the app half-up, this fails loudly and the
    // fragment (and its cost) can be revisited.
    const [row] = [
      ...(await db.execute<{ naive: string; even: string }>(
        sql`SELECT round(50.005::numeric, 2)::text AS naive,
                   ${halfEvenCents(sql`50.005::numeric`)}::text AS even`,
      )),
    ];
    expect(new Decimal(row?.naive ?? "0").toFixed(2)).toBe("50.01");
    expect(new Decimal(row?.even ?? "0").toFixed(2)).toBe("50.00");
    expect(Money.fromString("50.005", "USD").toString()).toBe("50.00");
  });

  it("cannot produce decimal.js's negative zero — and that never escapes a SUM", async () => {
    const [row] = [
      ...(await db.execute<{ rounded: string }>(
        sql`SELECT ${halfEvenCents(sql`(-0.004)::numeric`)}::text AS rounded`,
      )),
    ];
    // The documented difference: decimal.js says "-0.00", Postgres says "0.00".
    expect(Money.fromString("-0.004", "USD").toString()).toBe("-0.00");
    expect(new Decimal(row?.rounded ?? "1").isZero()).toBe(true);
    expect(new Decimal(row?.rounded ?? "1").toFixed(2)).toBe("0.00");

    // …and why it is harmless. The "-0.00" is a transient *string*: decimal.js
    // emits it only from `toFixed` on a nonzero value that rounds to zero, and
    // `valueHolding` immediately feeds that string back into `Money.fromString`.
    // An exact zero — whatever its internal sign — renders as "0.00", so no
    // money value the app can display ever carries the minus.
    expect(new Decimal("-0.004").toFixed(2)).toBe("-0.00");
    const perHolding = Money.fromString(new Decimal("-0.004").toFixed(2), "USD");
    expect(perHolding.toString()).toBe("0.00");
    expect(Money.zero("USD").add(perHolding).toString()).toBe("0.00");
  });
});
