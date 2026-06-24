import { toAccountId } from "@/lib/types/ids.ts";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildTransactionWhere } from "./queries.ts";

/**
 * P12-07 — WHERE-composition tests for the transaction-filter query builder.
 *
 * `buildTransactionWhere` is pure (builds SQL, no DB), so the assertions render
 * the fragment to its parameterized `{ sql, params }` form and check that the
 * right clauses — and only those — are present, with every value bound (never
 * inlined). This is the always-test surface per CLAUDE.md §Testing Philosophy: a
 * query builder guarding a financial-data read path.
 */

const dialect = new PgDialect();
const ACCOUNT = toAccountId("11111111-1111-4111-8111-111111111111");
const CATEGORY = "22222222-2222-4222-8222-222222222222";

/** Render the (defined) predicate to `{ sql, params }`. */
function render(fragment: ReturnType<typeof buildTransactionWhere>) {
  expect(fragment).toBeDefined();
  return dialect.sqlToQuery(fragment as NonNullable<typeof fragment>);
}

describe("buildTransactionWhere", () => {
  it("returns undefined when nothing constrains the query (all transactions)", () => {
    expect(buildTransactionWhere(undefined, undefined)).toBeUndefined();
    expect(buildTransactionWhere(undefined, {})).toBeUndefined();
  });

  it("scopes to one account when accountId is given", () => {
    const { sql, params } = render(buildTransactionWhere(ACCOUNT, undefined));
    expect(sql).toContain('"transactions"."account_id" =');
    expect(params).toEqual([ACCOUNT]);
  });

  it("matches free text on name OR memo, bound — not inlined", () => {
    const { sql, params } = render(buildTransactionWhere(undefined, { q: "coffee" }));
    expect(sql).toContain('"transactions"."name" ILIKE');
    expect(sql).toContain('"transactions"."memo" ILIKE');
    expect(sql.toLowerCase()).toContain(" or ");
    expect(sql).not.toContain("coffee");
    expect(params).toEqual(["%coffee%", "%coffee%"]);
  });

  it("drops a too-short free-text term (sanitizer short-circuit)", () => {
    expect(buildTransactionWhere(undefined, { q: "a" })).toBeUndefined();
    expect(buildTransactionWhere(undefined, { q: "  " })).toBeUndefined();
  });

  it("applies an inclusive date range with both bounds bound", () => {
    const { sql, params } = render(
      buildTransactionWhere(undefined, { from: "2026-01-01", to: "2026-03-31" }),
    );
    expect(sql).toContain('"transactions"."posted_at" >=');
    expect(sql).toContain('"transactions"."posted_at" <=');
    expect(params).toEqual(["2026-01-01", "2026-03-31"]);
  });

  it("applies the amount range on the stored signed amount column", () => {
    const { sql, params } = render(
      buildTransactionWhere(undefined, { minAmount: "-100.00", maxAmount: "-10.00" }),
    );
    expect(sql).toContain('"transactions"."amount" >=');
    expect(sql).toContain('"transactions"."amount" <=');
    expect(params).toEqual(["-100.00", "-10.00"]);
  });

  it("filters by category id", () => {
    const { sql, params } = render(buildTransactionWhere(undefined, { categoryId: CATEGORY }));
    expect(sql).toContain('"transactions"."category_id" =');
    expect(params).toEqual([CATEGORY]);
  });

  it("filters uncategorized via IS NULL, not an equality bind", () => {
    const { sql, params } = render(
      buildTransactionWhere(undefined, { categoryId: "uncategorized" }),
    );
    expect(sql.toLowerCase()).toContain('"transactions"."category_id" is null');
    expect(params).toEqual([]);
  });

  it("composes every clause together (account + all filters)", () => {
    const { sql, params } = render(
      buildTransactionWhere(ACCOUNT, {
        q: "amazon",
        from: "2026-01-01",
        to: "2026-12-31",
        minAmount: "10.00",
        maxAmount: "500.00",
        categoryId: CATEGORY,
      }),
    );
    expect(sql).toContain('"transactions"."account_id" =');
    expect(sql).toContain("ILIKE");
    expect(sql).toContain('"transactions"."posted_at" >=');
    expect(sql).toContain('"transactions"."posted_at" <=');
    expect(sql).toContain('"transactions"."amount" >=');
    expect(sql).toContain('"transactions"."amount" <=');
    expect(sql).toContain('"transactions"."category_id" =');
    expect(params).toEqual([
      ACCOUNT,
      "%amazon%",
      "%amazon%",
      "2026-01-01",
      "2026-12-31",
      "10.00",
      "500.00",
      CATEGORY,
    ]);
  });
});
