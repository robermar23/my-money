import { describe, expect, it } from "vitest";
import {
  MAX_SEARCH_TERM_LENGTH,
  MIN_SEARCH_TERM_LENGTH,
  escapeLikeWildcards,
  sanitizeSearchTerm,
} from "./term.ts";

describe("sanitizeSearchTerm", () => {
  it("returns null for empty / whitespace-only / too-short input", () => {
    expect(sanitizeSearchTerm("")).toBeNull();
    expect(sanitizeSearchTerm("   ")).toBeNull();
    expect(sanitizeSearchTerm("a")).toBeNull(); // 1 char < MIN
    expect(sanitizeSearchTerm("  x  ")).toBeNull(); // collapses to 1 char
  });

  it("returns null for non-string input (defensive)", () => {
    expect(sanitizeSearchTerm(null)).toBeNull();
    expect(sanitizeSearchTerm(undefined)).toBeNull();
    // @ts-expect-error — guarding against runtime misuse
    expect(sanitizeSearchTerm(42)).toBeNull();
  });

  it("accepts a term exactly at the minimum length", () => {
    expect(MIN_SEARCH_TERM_LENGTH).toBe(2);
    expect(sanitizeSearchTerm("ab")).toBe("ab");
  });

  it("trims and collapses internal whitespace", () => {
    expect(sanitizeSearchTerm("  whole   foods  ")).toBe("whole foods");
    expect(sanitizeSearchTerm("a\t\nb")).toBe("a b");
  });

  it("does NOT escape wildcards (that is the predicate's job, not normalization)", () => {
    expect(sanitizeSearchTerm("50%")).toBe("50%");
    expect(sanitizeSearchTerm("a_b")).toBe("a_b");
  });

  it("caps the term length", () => {
    const long = "x".repeat(MAX_SEARCH_TERM_LENGTH + 50);
    const result = sanitizeSearchTerm(long);
    expect(result).not.toBeNull();
    expect((result as string).length).toBe(MAX_SEARCH_TERM_LENGTH);
  });

  it("leaves ordinary terms untouched", () => {
    expect(sanitizeSearchTerm("Amazon")).toBe("Amazon");
    expect(sanitizeSearchTerm("AAPL")).toBe("AAPL");
  });
});

describe("escapeLikeWildcards", () => {
  it("escapes LIKE wildcard metacharacters so they match literally", () => {
    expect(escapeLikeWildcards("50%")).toBe("50\\%");
    expect(escapeLikeWildcards("a_b")).toBe("a\\_b");
    expect(escapeLikeWildcards("amazon%_x")).toBe("amazon\\%\\_x");
  });

  it("escapes backslashes before adding its own (no double-escaping)", () => {
    expect(escapeLikeWildcards("a\\b")).toBe("a\\\\b");
    expect(escapeLikeWildcards("\\%")).toBe("\\\\\\%");
  });

  it("leaves ordinary terms untouched", () => {
    expect(escapeLikeWildcards("Amazon")).toBe("Amazon");
    expect(escapeLikeWildcards("whole foods")).toBe("whole foods");
  });
});
