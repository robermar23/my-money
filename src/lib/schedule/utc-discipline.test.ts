// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P19-24: my-money dates its days in UTC, and before P19-24 the container's
 * clock was UTC too, so a local-clock getter would have gone unnoticed. Now an
 * operator can set `TZ`, which moves the process's local clock, and any date
 * math done on that clock would move the figures with it (Hard boundary #3).
 * This guard keeps the discipline the code already follows: no local-clock
 * getters or setters, and no local-time `Date` constructor, anywhere in `src/`.
 * Use the `getUTC*` and `setUTC*` forms, or an ISO string with a `Z`.
 */

const LOCAL_CLOCK =
  /\.(getFullYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds|getTimezoneOffset|setFullYear|setMonth|setDate|setHours|setMinutes|setSeconds)\(/;
/** `new Date(2026, 0, 1)`: the multi-argument constructor reads the local clock. */
const LOCAL_CONSTRUCTOR = /new Date\(\s*[\w.]+\s*,/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("UTC date discipline", () => {
  it("finds no local-clock date math in src/", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (LOCAL_CLOCK.test(line) || LOCAL_CONSTRUCTOR.test(line)) {
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it("would catch the patterns it exists for", () => {
    expect(LOCAL_CLOCK.test("d.getDate()")).toBe(true);
    expect(LOCAL_CLOCK.test("d.getUTCDate()")).toBe(false);
    expect(LOCAL_CONSTRUCTOR.test("new Date(year, month - 1, 1)")).toBe(true);
    expect(LOCAL_CONSTRUCTOR.test("new Date(Date.UTC(y, m, 1))")).toBe(false);
  });
});
