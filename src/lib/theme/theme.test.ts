// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseTheme, themeCookie } from "./theme.ts";

describe("parseTheme", () => {
  it("should accept light and dark", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
  });

  it("should fall back to system for missing or unknown values", () => {
    expect(parseTheme(undefined)).toBe("system");
    expect(parseTheme("")).toBe("system");
    expect(parseTheme("Dark")).toBe("system");
    expect(parseTheme("system")).toBe("system");
  });
});

describe("themeCookie", () => {
  it("should keep a forced theme for a year", () => {
    expect(themeCookie("dark")).toBe("my-money-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax");
  });

  it("should expire the cookie when going back to system", () => {
    expect(themeCookie("system")).toContain("Max-Age=0");
  });
});
