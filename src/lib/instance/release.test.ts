// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import journal from "../../../drizzle/meta/_journal.json";
import pkg from "../../../package.json";

/**
 * P19-19 / P19-20 (ADR-054 §2/§3): a release is identifiable. The version in
 * `package.json`, the top CHANGELOG entry, and that entry's `Migrations:` line
 * must agree with each other and with `drizzle/`, or an operator reading the
 * changelog is told the wrong thing about whether to migrate.
 */

const changelog = readFileSync("CHANGELOG.md", "utf8");
const tags = new Set(journal.entries.map((e) => e.tag));
const newestTag = journal.entries.at(-1)?.tag;

/** Each `## ` or `### ` entry heading, with the body up to the next heading. */
function entries(): { heading: string; body: string }[] {
  const parts = changelog.split(/^(#{2,3} .+)$/m);
  const out: { heading: string; body: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i] ?? "";
    // Section headings inside a release, not releases themselves.
    if (/^### (Added|Changed|Fixed|Removed|Security|Upgrade notes)$/.test(heading)) continue;
    if (heading === "## Before 0.19.0") continue;
    out.push({ heading, body: parts[i + 1] ?? "" });
  }
  return out;
}

function migrationOf(body: string): string | undefined {
  return /^\*\*Migrations:\*\* `([^`]+)`/m.exec(body)?.[1];
}

describe("CHANGELOG.md", () => {
  it("opens with the version package.json carries", () => {
    const top = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog)?.[1];
    expect(top).toBe(pkg.version);
  });

  it("names the newest migration in drizzle/ on the top release", () => {
    const [top] = entries();
    expect(top?.heading).toMatch(/^## \[/);
    expect(migrationOf(top?.body ?? "")).toBe(newestTag);
  });

  it("gives every release a Migrations line naming a real migration", () => {
    const all = entries();
    expect(all.length).toBeGreaterThan(10);
    for (const { heading, body } of all) {
      const tag = migrationOf(body);
      expect(tag, `${heading} has no Migrations: line`).toBeDefined();
      expect(tags.has(tag ?? ""), `${heading} names unknown migration ${tag}`).toBe(true);
    }
  });

  it("never names an older migration above a newer one", () => {
    const order = entries().map(({ body }) => Number(migrationOf(body)?.slice(0, 4)));
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1]).toBeGreaterThanOrEqual(order[i] ?? 0);
    }
  });
});
