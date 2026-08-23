import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { navigateDirect, navigateVia } from "./helpers/nav.ts";

/**
 * Phase 10 manual flow (P10-18): bootstrap → create a `personal_asset` (vehicle,
 * with an acquisition cost) → record a value → assert it shows on the detail
 * page, in the snapshot history, and contributes to net worth on the dashboard →
 * upload a small PDF proof document → assert it lists and the download link
 * resolves as an attachment → record a higher value → assert the gain/loss flips
 * from a loss to a gain.
 *
 * Truncates domain tables (incl. `asset_documents`) first so the spec is
 * independent of any other spec's state.
 */

/** A minimal but valid PDF (%PDF header + EOF) — passes the magic-byte sniff. */
const PDF_FIXTURE = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");

test.describe("phase 10: personal assets → net worth + proof documents", () => {
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
        "TRUNCATE users, accounts, holdings, account_snapshots, liabilities, asset_documents CASCADE",
      );
    } finally {
      await sql.end();
    }
  });

  test("walks the full Phase 10 happy path", async ({ page }) => {
    // ── 1. Bootstrap (set password) ─────────────────────────────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();
    await expect(page).toHaveURL("/");

    // ── 2. Create a personal asset (vehicle, with acquisition cost) ──────────
    await navigateVia(page, "Accounts", "All accounts");
    await page.getByRole("link", { name: /add account/i }).click();
    await expect(page).toHaveURL(/\/accounts\/new$/);

    // Selecting the asset type swaps the Institution field for asset fields.
    await page.getByLabel("Type").selectOption("personal_asset");
    await expect(page.getByLabel("Institution")).toHaveCount(0);
    await page.getByLabel("Name").fill("2021 Tacoma");
    await page.getByLabel("Category").selectOption("vehicle");
    await page.getByLabel("Acquisition cost").fill("38000.00");
    await page.getByRole("button", { name: /create asset/i }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]+$/);

    // Header shows the category (never the "Personal asset" sentinel institution).
    await expect(page.getByText("Vehicle")).toBeVisible();
    await expect(page.getByRole("heading", { name: /acquisition/i })).toBeVisible();

    // ── 3. Record a value below cost → gain/loss shows a loss ────────────────
    await page.getByLabel("Valuation date").fill("2026-06-01");
    await page.getByLabel("Current value").fill("35000.00");
    await page.getByRole("button", { name: /save valuation/i }).click();
    await expect(page.getByText(/saved/i)).toBeVisible();
    // Loss = 35,000 − 38,000 = −$3,000.00.
    await expect(page.getByText(/\$3,000\.00/)).toBeVisible();

    // Snapshot history renders the entry.
    await expect(page.getByRole("heading", { name: /snapshot history/i })).toBeVisible();
    await expect(page.locator("table")).toContainText("$35,000.00");

    // ── 4. Net worth on the dashboard includes the valued asset ─────────────
    await navigateDirect(page, "Dashboard");
    await expect(page).toHaveURL("/");
    await expect(page.locator("table")).toContainText("2021 Tacoma");
    await expect(page.locator("table")).toContainText("$35,000.00");

    // ── 5. Upload a proof document, then download it (attachment) ────────────
    await navigateVia(page, "Accounts", "All accounts");
    await page.getByRole("link", { name: "2021 Tacoma" }).click();
    await expect(page.getByRole("heading", { name: /proof of authenticity/i })).toBeVisible();

    await page.getByLabel("File").setInputFiles({
      name: "title.pdf",
      mimeType: "application/pdf",
      buffer: PDF_FIXTURE,
    });
    await page.getByLabel("Description").fill("Vehicle title");
    await page.getByRole("button", { name: /upload document/i }).click();
    // Exact match on the confirmation copy — a bare /uploaded/i also matches the
    // documents table's "Uploaded" column header.
    await expect(page.getByText("Uploaded.", { exact: true })).toBeVisible();
    // The account detail page renders two tables (documents, then balance
    // history); the uploaded file lands in the first.
    await expect(page.locator("table").first()).toContainText("title.pdf");

    // The download link serves the file as an attachment (never inline).
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "title.pdf" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("title.pdf");

    // ── 6. Record a higher value → gain/loss flips to a gain ────────────────
    await page.getByLabel("Valuation date").fill("2026-06-21");
    await page.getByLabel("Current value").fill("40000.00");
    await page.getByRole("button", { name: /save valuation/i }).click();
    await expect(page.getByText(/saved/i)).toBeVisible();
    // Gain = 40,000 − 38,000 = +$2,000.00.
    await expect(page.getByText(/\$2,000\.00/)).toBeVisible();
  });
});
