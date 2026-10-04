import { type Page, expect, test } from "@playwright/test";
import postgres from "postgres";
import { navigateDirect, navigateVia } from "./helpers/nav.ts";

/**
 * Phase 1 critical flow: bootstrap → create checking account → enter balance
 * → create mortgage → see net worth on the dashboard.
 *
 * Step 3b rides along on the same flow: a credit card's balance field asks for
 * an **amount owed** and is stored negated (P17-32, ADR-042). It is here rather
 * than in a spec of its own because the label change is the one part of that
 * batch no unit test can see, and this flow already has an account-creation
 * browser open.
 *
 * Truncates domain tables before running so this spec is independent of any
 * other spec's state (auth.spec leaves a user row behind).
 */
test.describe("phase 1: manual entry → net worth on dashboard", () => {
  test.beforeAll(async () => {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      /* CI env */
    }
    const databaseUrl =
      process.env.DATABASE_URL ?? "postgres://money:dev_password_change_me@127.0.0.1:5433/money";
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql.unsafe(
        "TRUNCATE users, accounts, holdings, account_snapshots, liabilities CASCADE",
      );
    } finally {
      await sql.end();
    }
  });

  test("walks the full Phase 1 happy path", async ({ page }) => {
    // ── 1. Bootstrap (set password) ─────────────────────────────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // A brand-new install has no accounts, so the dashboard collapses to the
    // first-run instruction rather than seven empty cards (P13-16, ADR-029 §5).
    // The net-worth hero is asserted at step 5, once there is a net worth.
    await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /add an account/i })).toBeVisible();

    // ── 1b. The grouped nav (NAV-12, ADR-035) ───────────────────────────────
    // Not a fourth critical flow — CLAUDE.md caps Playwright at three — but the
    // chrome every one of them navigates through, asserted where it is cheapest.
    await assertGroupedNav(page);

    // ── 2. Create a depository (checking) account ───────────────────────────
    await navigateVia(page, "Accounts", "All accounts");
    await expect(page).toHaveURL(/\/accounts$/);

    await page.getByRole("link", { name: /add account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/new$/);
    await page.getByLabel("Name").fill("M&T Checking");
    await page.getByLabel("Institution").fill("M&T Bank");
    await page.getByLabel("Type").selectOption("depository");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+$/);

    // ── 3. Record a balance ─────────────────────────────────────────────────
    // `exact` throughout: several account types also carry a "Minimum payment
    // (% of balance)" field, and Playwright's default substring match would
    // find that instead and pass for the wrong reason.
    await expect(page.getByLabel("Balance", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Amount owed", { exact: true })).toHaveCount(0);
    await page.getByLabel("Balance", { exact: true }).fill("5000.00");
    await page.getByRole("button", { name: /save balance/i }).click();
    await expect(page.getByText(/saved/i)).toBeVisible();

    // Back to the accounts list; new account shows with the formatted balance.
    await navigateVia(page, "Accounts", "All accounts");
    await expect(page.locator("table")).toContainText("M&T Checking");
    await expect(page.locator("table")).toContainText("$5,000.00");

    // ── 3b. A credit card: the field asks for an AMOUNT OWED (P17-32, ADR-042)
    // Folded into this flow rather than given its own spec — the arithmetic is
    // already covered by 21 unit tests on `snapshotBalance` and 5 DB-backed
    // cases in `credit-card-sign.test.ts`, and the full Playwright suite is
    // close enough to its resource ceiling that an extra bootstrap+truncate
    // spec destabilized the QFX flow. Same argument as `assertGroupedNav`
    // below: asserted where it is cheapest.
    //
    // What only a browser can check is ADR-042 §3's claim that **the relabel is
    // not cosmetic**. Nothing in the unit suites would notice a revert of it: a
    // form saying "Balance" above storage that negates passes every test in the
    // repo, and is worse than either behaviour on its own. So the label is
    // asserted in both directions, then the household's own arithmetic.
    await page.getByRole("link", { name: /add account/i }).click();
    await page.getByLabel("Name").fill("Sapphire Visa");
    await page.getByLabel("Institution").fill("Chase");
    await page.getByLabel("Type").selectOption("credit_card");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+$/);

    await expect(page.getByLabel("Amount owed", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Balance", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/statement says you owe/i)).toBeVisible();

    // The household types what the statement says. Positive.
    await page.getByLabel("Amount owed", { exact: true }).fill("1200.00");
    await page.getByRole("button", { name: /save balance/i }).click();
    await expect(page.getByText(/saved/i).first()).toBeVisible();

    // Stored as a net-worth contribution: the card reads as a liability.
    // Entered verbatim — the behaviour before ADR-042 — this row would say
    // "$1,200.00" and net worth would be $2,400 too high with no warning.
    await navigateVia(page, "Accounts", "All accounts");
    await expect(page.locator("table")).toContainText("Sapphire Visa");
    await expect(page.locator("table")).toContainText("-$1,200.00");

    // ── 4. Create a mortgage (loan account + amortization params) ───────────
    await page.getByRole("link", { name: /add account/i }).click();
    await page.getByLabel("Name").fill("Sunwest Mortgage");
    await page.getByLabel("Institution").fill("Sunwest");
    await page.getByLabel("Type").selectOption("loan");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+$/);

    // Mortgage form is rendered for loan accounts.
    await expect(page.getByRole("heading", { name: /mortgage parameters/i })).toBeVisible();
    await page.getByLabel("Loan name").fill("Sunwest 30yr fixed");
    await page.getByLabel("Principal at origination").fill("200000.00");
    await page.getByLabel("Annual rate").fill("0.06");
    await page.getByLabel("Term (months)").fill("360");
    // Pick a start date in the past so amortization shows some progress
    await page.getByLabel("Start date").fill("2024-01-01");
    await page.getByRole("button", { name: /save mortgage/i }).click();
    await expect(page.getByText(/saved/i)).toBeVisible();

    // Loan account detail shows a computed balance via amortization (negative).
    await expect(page.getByText(/computed from amortization/i)).toBeVisible();

    // ── 5. Dashboard shows the combined net worth ───────────────────────────
    await navigateDirect(page, "Dashboard");
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: /net worth/i })).toBeVisible();
    await expect(page.locator("table")).toContainText("M&T Checking");
    await expect(page.locator("table")).toContainText("Sunwest Mortgage");
    await expect(page.locator("table")).toContainText("Sapphire Visa");
    await expect(page.getByText("$5,000.00")).toBeVisible();
  });
});

/**
 * Assert the grouped top bar's structure and keyboard contract (NAV-12).
 *
 * Covers PLAN_NAV §8 criteria 1 (fits at 1,024 px without wrapping), 4 (`Esc`
 * closes and restores focus to the trigger), 5 (`aria-current="page"` on the
 * active link) and 6 (a deep route lights its parent group).
 */
async function assertGroupedNav(page: Page): Promise<void> {
  const nav = page.locator("header");

  // Narrow to the width the flat 12-link bar used to overflow at.
  const original = page.viewportSize();
  await page.setViewportSize({ width: 1024, height: 800 });

  // Six group entries: Dashboard is a plain link (single-item group), the other
  // five are disclosure triggers. "Analysis" arrived with P18-26, which split
  // the overfull Planning group — so the no-wrap assertion below is now load
  // bearing for the sixth slot ADR-035 §2 caps the bar at.
  const triggers = ["Accounts", "Investing", "Analysis", "Planning", "Settings"];
  await expect(nav.getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
  for (const label of triggers) {
    await expect(nav.getByRole("button", { name: label, exact: true })).toBeVisible();
  }

  // The bar does not wrap: every trigger sits on the same row as the brand.
  const brandBox = await nav.getByRole("link", { name: "my-money" }).boundingBox();
  for (const label of triggers) {
    const box = await nav.getByRole("button", { name: label, exact: true }).boundingBox();
    expect(box, `${label} trigger has no box`).not.toBeNull();
    expect(
      Math.abs((box?.y ?? 0) - (brandBox?.y ?? 0)),
      `nav wrapped at 1024px — "${label}" fell to another row`,
    ).toBeLessThan(16);
  }

  // A disclosure opens on click, shows its group's destinations, and `Esc`
  // closes it while returning focus to the trigger (ARIA APG disclosure).
  const investing = nav.getByRole("button", { name: "Investing", exact: true });
  await investing.click();
  await expect(investing).toHaveAttribute("aria-expanded", "true");
  for (const item of ["Portfolio", "Performance", "Forecast", "Watchlist"]) {
    await expect(nav.getByRole("link", { name: item, exact: true })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(investing).toHaveAttribute("aria-expanded", "false");
  await expect(investing).toBeFocused();

  // Only one group opens at a time.
  await nav.getByRole("button", { name: "Planning", exact: true }).click();
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(nav.getByRole("button", { name: "Planning", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.keyboard.press("Escape");

  // A deep route lights its parent group, and the section strip appears with
  // the current destination marked.
  await page.goto("/investments/performance");
  await expect(nav.getByRole("button", { name: "Investing", exact: true })).toHaveClass(
    /font-medium/,
  );
  const strip = page.getByRole("navigation", { name: "Investing sections" });
  await expect(strip).toBeVisible();
  await expect(strip.getByRole("link", { name: "Performance" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(strip.getByRole("link", { name: "Portfolio" })).not.toHaveAttribute(
    "aria-current",
    "page",
  );

  // Every destination is ⌘K-reachable by label, however deep it is nested.
  await page.keyboard.press("ControlOrMeta+k");
  const box = page.getByRole("combobox", { name: /search/i });
  await expect(box).toBeVisible();
  await box.fill("forecast");
  await expect(page.getByRole("group", { name: "Pages" })).toBeVisible();
  await page
    .getByRole("option", { name: /Forecast/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/investments\/forecast$/);

  if (original) await page.setViewportSize(original);
  await page.goto("/");
}
