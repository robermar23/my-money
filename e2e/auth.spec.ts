import { expect, test } from "@playwright/test";

/**
 * Auth flow — single password field, no email, no setup wizard.
 *
 * First visit with an empty users table: the page shows "Set a password"; the
 * submitted password becomes the only password. Subsequent visits show
 * "Enter your password" and verify against the stored argon2id hash.
 */
test.describe("auth: single-password login", () => {
  test("first visit sets the password and signs the user in", async ({ page }) => {
    await page.goto("/");
    // Unauthenticated → /login
    await expect(page).toHaveURL(/\/login$/);
    // First-run copy
    await expect(page.getByText(/set a password/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /set password/i })).toBeVisible();

    await page.getByLabel("Password").fill("hunter2");
    await page.getByRole("button", { name: /set password/i }).click();

    // Lands on the authenticated dashboard.
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: /net worth/i })).toBeVisible();
  });

  test("after bootstrap, /login shows the verify form (not the set-password form)", async ({
    page,
  }) => {
    await page.goto("/login");
    // Either we're already signed in (redirect to /) or we see the verify copy.
    if (new URL(page.url()).pathname === "/login") {
      await expect(page.getByText(/enter your password/i)).toBeVisible();
      await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
    } else {
      // Already signed in from the previous test (year-long session) — fine.
      await expect(page).toHaveURL("/");
    }
  });
});
