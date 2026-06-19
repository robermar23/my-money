import type { CategoryRule } from "@/db/schema/index.ts";
import { describe, expect, it } from "vitest";
import {
  clearRegexCache,
  escapeRegexLiteral,
  matchCategory,
  sortRules,
  validateRegex,
} from "./match.ts";

function rule(
  partial: Partial<CategoryRule> & { pattern: string; category: string },
): CategoryRule {
  return {
    id: crypto.randomUUID(),
    pattern: partial.pattern,
    flags: partial.flags ?? "i",
    field: partial.field ?? "name",
    category: partial.category,
    categoryId: partial.categoryId ?? null,
    priority: partial.priority ?? 100,
    enabled: partial.enabled ?? true,
    createdAt: partial.createdAt ?? new Date(2026, 0, 1),
    updatedAt: partial.updatedAt ?? new Date(2026, 0, 1),
  };
}

describe("matchCategory", () => {
  it("returns null when nothing matches", () => {
    const rules = [rule({ pattern: "STARBUCKS", category: "Coffee" })];
    expect(matchCategory("WEGMANS FOOD MARKET", null, rules)).toBeNull();
  });

  it("matches case-insensitively by default", () => {
    const rules = [rule({ pattern: "starbucks", category: "Coffee" })];
    expect(matchCategory("STARBUCKS STORE 4521", null, rules)?.name).toBe("Coffee");
  });

  it("returns the matched rule's categoryId alongside the name", () => {
    const id = crypto.randomUUID();
    const rules = [rule({ pattern: "STARBUCKS", category: "Coffee", categoryId: id })];
    expect(matchCategory("STARBUCKS STORE 4521", null, rules)).toEqual({
      categoryId: id,
      name: "Coffee",
    });
  });

  it("returns a null categoryId when the rule has not been linked yet", () => {
    const rules = [rule({ pattern: "STARBUCKS", category: "Coffee", categoryId: null })];
    expect(matchCategory("STARBUCKS", null, rules)).toEqual({ categoryId: null, name: "Coffee" });
  });

  it("returns the first matching rule when sorted by priority", () => {
    const rules = sortRules([
      rule({ pattern: "PAYMENT", category: "Payment", priority: 10 }),
      rule({ pattern: "AMAZON", category: "Shopping", priority: 50 }),
    ]);
    // Both could match "AMAZON PAYMENT" but priority 10 wins.
    expect(matchCategory("AMAZON PAYMENT", null, rules)?.name).toBe("Payment");
  });

  it("skips disabled rules", () => {
    const rules = [rule({ pattern: "STARBUCKS", category: "Coffee", enabled: false })];
    expect(matchCategory("STARBUCKS", null, rules)).toBeNull();
  });

  it("matches against memo when field='memo'", () => {
    const rules = [rule({ pattern: "GROCERY", category: "Groceries", field: "memo" })];
    expect(matchCategory("WHOLEFDS", "GROCERY", rules)?.name).toBe("Groceries");
    expect(matchCategory("WHOLEFDS", null, rules)).toBeNull();
  });

  it("tolerates a malformed pattern that snuck in (returns null, doesn't throw)", () => {
    clearRegexCache();
    const bad = rule({ pattern: "(((", category: "Should Not Match" });
    expect(() => matchCategory("anything", null, [bad])).not.toThrow();
    expect(matchCategory("anything", null, [bad])).toBeNull();
  });
});

describe("validateRegex", () => {
  it("returns null on valid pattern", () => {
    expect(validateRegex("AMAZON.*", "i")).toBeNull();
  });
  it("returns an error message on invalid pattern", () => {
    expect(validateRegex("(((", "i")).toMatch(/group|paren|invalid/i);
  });
  it("rejects invalid flags", () => {
    expect(validateRegex("a", "zzz")).toMatch(/flag/i);
  });
});

describe("escapeRegexLiteral", () => {
  it("escapes regex metacharacters so a payee matches literally", () => {
    const escaped = escapeRegexLiteral("AT&T STORE (MAIN) $5+");
    // The escaped string compiled as a regex must match the original literally.
    expect(new RegExp(escaped).test("AT&T STORE (MAIN) $5+")).toBe(true);
    // And metacharacters must not act as operators.
    expect(new RegExp(escaped).test("ATTTT STORE MAIN 5")).toBe(false);
  });

  it("leaves plain text unchanged", () => {
    expect(escapeRegexLiteral("STARBUCKS")).toBe("STARBUCKS");
  });

  it("escapes every reserved character", () => {
    expect(escapeRegexLiteral(".*+?^${}()|[]\\")).toBe(
      "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\",
    );
  });
});

describe("sortRules", () => {
  it("orders by priority asc, then createdAt asc", () => {
    const a = rule({ pattern: "A", category: "A", priority: 10, createdAt: new Date(2026, 0, 2) });
    const b = rule({ pattern: "B", category: "B", priority: 10, createdAt: new Date(2026, 0, 1) });
    const c = rule({ pattern: "C", category: "C", priority: 5, createdAt: new Date(2026, 0, 3) });
    expect(sortRules([a, b, c]).map((r) => r.category)).toEqual(["C", "B", "A"]);
  });
});
