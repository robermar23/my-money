import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { navigateDirect, navigateVia } from "./helpers/nav.ts";

/**
 * Phase 19 critical flow (P19-38): **the first ten minutes of a second
 * operator** — someone who is not the author, on a fresh install.
 *
 * PLAN19 adds this one flow to the critical set (CLAUDE.md §Testing
 * Philosophy keeps that set small on purpose) because it is the path every
 * adopter walks, and each of its four surfaces is new or changed this phase:
 *
 *   1. **`/login` sets the password.** An empty `users` table means the first
 *      submitted password becomes the only one (ADR-004) — no email, no
 *      username, no wizard.
 *   2. **`/settings/instance` says backups are not configured** (ADR-052). The
 *      page reads the worker's configuration from the worker's own heartbeat,
 *      so the spec runs the real heartbeat processor once with
 *      `BACKUP_AGE_RECIPIENT` unset (see helpers/heartbeat-once.ts). An inert
 *      safety feature has to say so on the screen an operator opens, not only
 *      in a log.
 *   3. **The page is the one built to be shared**, so its "Safe to share"
 *      notice is asserted, and its password section is present with nothing
 *      pre-filled.
 *   4. **A manual account appears on the dashboard** with its balance — the
 *      product working at all, after the setup surfaces above.
 *
 * Truncates domain tables first, as phase1.spec does, so the run starts from a
 * genuinely fresh instance whatever ran before it.
 */

/**
 * Every URL wait follows a navigation to a route `next dev` may be compiling
 * for the first time in this run, which takes longer than the 5 s default on a
 * loaded machine. The assertions are about where the flow lands, not how fast.
 */
const ROUTE_COMPILE = { timeout: 30_000 } as const;

const DEFAULT_DB = "postgres://money:dev_password_change_me@127.0.0.1:5433/money";

/** Run the worker's heartbeat once, over this environment minus the backup key. */
function reportWorkerHeartbeat(): void {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "BACKUP_AGE_RECIPIENT"),
  ) as NodeJS.ProcessEnv;
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./scripts/loaders/register.mjs",
      "e2e/helpers/heartbeat-once.ts",
    ],
    { env, stdio: "pipe", timeout: 60_000 },
  );
}

test.describe("phase 19: a second operator's first ten minutes", () => {
  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env */
    }
    const sql = postgres(process.env.DATABASE_URL ?? DEFAULT_DB, { max: 1 });
    try {
      await sql.unsafe(
        "TRUNCATE users, accounts, holdings, account_snapshots, liabilities CASCADE",
      );
    } finally {
      await sql.end();
    }
    reportWorkerHeartbeat();
  });

  test("password → instance page warns about backups → account → dashboard", async ({ page }) => {
    // ── 1. A fresh instance sends you to /login, which sets the password ──
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/, ROUTE_COMPILE);
    await expect(page.getByText(/set a password/i)).toBeVisible();
    await page.getByLabel("Password").fill("second-operator");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/", ROUTE_COMPILE);
    await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();

    // ── 2. Settings → Instance: backups are not configured, and it says how ─
    await navigateVia(page, "Settings", "Instance");
    await expect(page).toHaveURL(/\/settings\/instance$/, ROUTE_COMPILE);
    await expect(page.getByRole("heading", { name: "Instance", exact: true })).toBeVisible();
    const backups = page.locator("section", {
      has: page.getByRole("heading", { name: "Backups", exact: true }),
    });
    await expect(backups).toContainText("Nightly backup");
    await expect(backups).toContainText("Not configured");
    await expect(backups).toContainText("BACKUP_AGE_RECIPIENT");
    await expect(backups).toContainText("docs/BACKUP.md");

    // ── 3. The page built to be pasted into an issue says so, and the
    //       password section offers a change with nothing pre-filled ────────
    await expect(page.getByRole("heading", { name: "Safe to share" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Password", exact: true })).toBeVisible();
    const fields = page.locator('input[type="password"]');
    await expect(fields).toHaveCount(3);
    for (const field of await fields.all()) await expect(field).toHaveValue("");

    // ── 4. Create a manual account and give it a balance ───────────────────
    await navigateVia(page, "Accounts", "All accounts");
    await page.getByRole("link", { name: /add account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/new$/, ROUTE_COMPILE);
    await page.getByLabel("Name").fill("First Checking");
    await page.getByLabel("Institution").fill("Neighborhood Credit Union");
    await page.getByLabel("Type").selectOption("depository");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+$/, ROUTE_COMPILE);
    await page.getByLabel("Balance", { exact: true }).fill("2500.00");
    await page.getByRole("button", { name: /save balance/i }).click();
    await expect(page.getByText(/saved/i)).toBeVisible();

    // ── 5. It appears on the dashboard ──────────────────────────────────────
    await navigateDirect(page, "Dashboard");
    await expect(page).toHaveURL("/", ROUTE_COMPILE);
    await expect(page.getByRole("heading", { name: /net worth/i })).toBeVisible();
    await expect(page.locator("table")).toContainText("First Checking");
    await expect(page.getByText("$2,500.00").first()).toBeVisible();
  });
});
