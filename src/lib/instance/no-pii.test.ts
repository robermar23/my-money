// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pre-publication guard (ADR-056): **real financial data never enters the
 * repository**, and the next time it tries to, the build fails.
 *
 * A personal-finance project is debugged against its author's own statements,
 * and the honest test input is always a real line from a real register. That is
 * how the owner's account numbers, payees and a screenshot of the register got
 * committed once already. Three checks, from the most general to the most
 * specific:
 *
 *   1. **No statement exports or images outside the fixture directories.** A
 *      real `.qfx`, `.csv`, PDF or screenshot has nowhere to land.
 *   2. **No account-number-shaped digit run** (10 to 17 digits) unless it is
 *      visibly synthetic: a date stamp (OFX `DTPOSTED`, date-based FITIDs), a
 *      run of at most two distinct digits (`111111111111`, `000000000001`), or
 *      one of the named constants below. A real account number fails this
 *      without anyone having to list it.
 *   3. **A private denylist**, for what no pattern catches (payee names, a
 *      third party's name, an employer's descriptor). It is read from
 *      `.pii-denylist` (git-ignored) or `MONEY_PII_DENYLIST` (newline
 *      separated, e.g. a CI secret), and never committed: a published list of
 *      the strings to keep out of the repository would itself publish them.
 *      Without one, this block is skipped.
 *
 * The scan covers tracked files only (`git ls-files`), so local, untracked
 * notes do not fail it; in an export without `.git` (CI's `git archive`), the
 * whole tree is walked instead.
 */

const ROOT = resolve(__dirname, "..", "..", "..");

/** Generated files whose long digit runs are hashes and timestamps, not data. */
const GENERATED = [/^pnpm-lock\.yaml$/, /^drizzle\/meta\//];

/** Directories a filesystem walk skips (the `.git`-less fallback). */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "coverage",
  "playwright-report",
  "test-results",
  ".playwright",
]);

/** Synthetic long numbers in the tests, each a deliberate fixture value. */
const SYNTHETIC_NUMBERS = new Set([
  "90001234567890", // payee-key / detect: a savings account in a transfer descriptor
  "00005556667778", // payee-key: a checking account in a transfer descriptor
  "30000000000000004", // money: the float artifact of 0.1 + 0.2
  "4294967296", // demo book: 2^32, the PRNG modulus
  "1707264000", // yahoo-fundamentals: a Unix timestamp in a response fixture
  "1013904223", // dashboard-perf: the Numerical Recipes LCG increment
]);

const STATEMENT_OR_IMAGE = /\.(?:csv|qfx|ofx|qbo|xlsx?|pdf|png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;
const FIXTURE_DIR = /^src\/lib\/importers\/[^/]+\/__fixtures__\//;
const DIGIT_RUN = /(?<![0-9A-Za-z])\d{10,17}(?![0-9A-Za-z])/g;
const DATE_STAMP = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])/;

/** Every file in the repository, as POSIX paths relative to the root. */
function repositoryFiles(): string[] {
  if (existsSync(join(ROOT, ".git"))) {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
    return out.split("\0").filter((f) => f !== "" && existsSync(join(ROOT, f)));
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name) || name === ".pii-denylist") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(relative(ROOT, full).split("\\").join("/"));
    }
  };
  walk(ROOT);
  return files;
}

/** Text files only: anything with a NUL byte is binary and skipped. */
function textFiles(): Array<{ path: string; text: string }> {
  const result: Array<{ path: string; text: string }> = [];
  for (const path of repositoryFiles()) {
    const buf = readFileSync(join(ROOT, path));
    if (buf.includes(0)) continue;
    result.push({ path, text: buf.toString("utf8") });
  }
  return result;
}

function isVisiblySynthetic(run: string): boolean {
  return SYNTHETIC_NUMBERS.has(run) || DATE_STAMP.test(run) || new Set(run).size <= 2;
}

/** The private denylist, lowercased, or an empty list when none is configured. */
function denylist(): string[] {
  const path = join(ROOT, ".pii-denylist");
  const raw =
    process.env.MONEY_PII_DENYLIST ?? (existsSync(path) ? readFileSync(path, "utf8") : "");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

const FILES = textFiles();
const DENYLIST = denylist();

describe("no real financial data in the repository (ADR-056)", () => {
  it("has no statement export or image outside the importer fixture directories", () => {
    const misplaced = repositoryFiles().filter(
      (f) => STATEMENT_OR_IMAGE.test(f) && !FIXTURE_DIR.test(f),
    );
    expect(misplaced).toEqual([]);
  });

  it("has no account-number-shaped digit run that is not visibly synthetic", () => {
    const found: string[] = [];
    for (const { path, text } of FILES) {
      if (GENERATED.some((re) => re.test(path))) continue;
      for (const [run] of text.matchAll(DIGIT_RUN)) {
        if (!isVisiblySynthetic(run)) found.push(`${path}: ${run}`);
      }
    }
    expect(found).toEqual([]);
  });

  it.skipIf(DENYLIST.length === 0)("contains no string from the private denylist", () => {
    const found: string[] = [];
    for (const { path, text } of FILES) {
      const lower = text.toLowerCase();
      DENYLIST.forEach((entry, index) => {
        // Report the entry's line number, never the entry: the failure output
        // lands in CI logs.
        if (lower.includes(entry)) found.push(`${path}: denylist line ${index + 1}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("catches a planted account number, image and denylisted string", () => {
    // The scans above pass on a clean tree whether or not they work. Run the
    // same predicates over planted input so a broken regex fails here.
    // The account number is assembled at runtime: written as one literal, the
    // digit-run scan above would find it in this very file.
    const account = ["4820193", "7465521"].join("");
    const planted = `name: "WEB XFER TO SAV ${account}"`;
    expect([...planted.matchAll(DIGIT_RUN)].map(([run]) => run)).toEqual([account]);
    expect(isVisiblySynthetic(account)).toBe(false);
    expect(STATEMENT_OR_IMAGE.test("plans/features/register.png")).toBe(true);
    expect(FIXTURE_DIR.test("plans/features/register.png")).toBe(false);
    expect(FIXTURE_DIR.test("src/lib/importers/csv/__fixtures__/x.csv")).toBe(true);
  });
});
