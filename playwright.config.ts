import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for my-money.
 *
 * Per CLAUDE.md §Testing Philosophy, we test only the critical user flows here.
 * Phase 0: setup → login → see dashboard. Phase 1 will add QFX import flow.
 *
 * The web server is started by Playwright (`pnpm dev`) against the dev Postgres
 * container (docker compose up the postgres service first).
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:4000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
