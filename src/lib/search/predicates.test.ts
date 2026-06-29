import { transactions } from "@/db/schema/index.ts";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { similarityRank, trigramIlike, trigramIlikeAny } from "./predicates.ts";

const dialect = new PgDialect();

/** Render an SQL fragment to its parameterized `{ sql, params }` form. */
function render(fragment: Parameters<PgDialect["sqlToQuery"]>[0]) {
  return dialect.sqlToQuery(fragment);
}

describe("trigramIlike", () => {
  it("produces a parameterized ILIKE with the term bound, not inlined", () => {
    const { sql, params } = render(trigramIlike(transactions.name, "Amazon"));
    expect(sql).toContain('"transactions"."name" ILIKE');
    expect(sql).toContain("ESCAPE");
    // The %term% pattern is a single bound parameter — the term never appears
    // inline in the SQL string.
    expect(sql).not.toContain("Amazon");
    expect(params).toEqual(["%Amazon%"]);
  });

  it("escapes LIKE wildcards inside the bound pattern", () => {
    const { params } = render(trigramIlike(transactions.name, "50%"));
    expect(params).toEqual(["%50\\%%"]);
  });
});

describe("trigramIlikeAny", () => {
  it("OR-combines the predicate across columns", () => {
    const fragment = trigramIlikeAny([transactions.name, transactions.memo], "coffee");
    expect(fragment).toBeDefined();
    const { sql, params } = render(fragment as Parameters<typeof render>[0]);
    expect(sql).toContain('"transactions"."name" ILIKE');
    expect(sql).toContain('"transactions"."memo" ILIKE');
    expect(sql.toLowerCase()).toContain(" or ");
    expect(params).toEqual(["%coffee%", "%coffee%"]);
  });

  it("returns undefined for an empty column list (composes in and(...))", () => {
    expect(trigramIlikeAny([], "coffee")).toBeUndefined();
  });
});

describe("similarityRank", () => {
  it("produces a parameterized similarity() expression", () => {
    const { sql, params } = render(similarityRank(transactions.name, "Amazon"));
    expect(sql).toContain('similarity("transactions"."name",');
    expect(params).toEqual(["Amazon"]);
  });
});
