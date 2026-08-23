import { type Page, expect } from "@playwright/test";

/**
 * Nav helpers for the grouped top bar (NAV-12, ADR-035).
 *
 * The bar is no longer a flat row of links: four of the five groups are
 * disclosure menus, so "click the Accounts link" became "open the Accounts
 * menu, then click All accounts". Every spec that navigated by nav text goes
 * through here, so the next IA change is one edit rather than nine.
 *
 * Deliberately **not** a fourth critical flow — CLAUDE.md §Testing Philosophy
 * caps Playwright at three, and these helpers serve the existing ones.
 */

/** Scope every lookup to the chrome so page-body links never match by accident. */
function nav(page: Page) {
  return page.locator("header");
}

/**
 * Navigate via the desktop top bar: open `group`'s disclosure, click `item`.
 *
 * @param page - The Playwright page.
 * @param group - The bar trigger's label ("Accounts", "Investing", …).
 * @param item - The link's label inside the panel ("All accounts", …).
 */
export async function navigateVia(page: Page, group: string, item: string): Promise<void> {
  const trigger = nav(page).getByRole("button", { name: group, exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await nav(page).getByRole("link", { name: item, exact: true }).click();
}

/**
 * Navigate to a single-item group that renders as a plain link, not a menu.
 * Dashboard is the only one today.
 *
 * @param page - The Playwright page.
 * @param label - The link's label.
 */
export async function navigateDirect(page: Page, label: string): Promise<void> {
  await nav(page).getByRole("link", { name: label, exact: true }).click();
}

/**
 * Navigate via the mobile hamburger accordion: open the panel, expand the
 * group's section, then tap the destination.
 *
 * @param page - The Playwright page (small viewport).
 * @param group - The accordion section header ("Accounts", "Investing", …).
 * @param item - The link inside that section.
 */
export async function navigateViaMobile(page: Page, group: string, item: string): Promise<void> {
  await page.getByRole("button", { name: /toggle navigation menu/i }).click();
  const section = nav(page).getByRole("button", { name: group, exact: true });
  // The current route's group opens expanded; only toggle a collapsed one.
  if ((await section.getAttribute("aria-expanded")) !== "true") await section.click();
  await expect(section).toHaveAttribute("aria-expanded", "true");
  await nav(page).getByRole("link", { name: item, exact: true }).click();
}
