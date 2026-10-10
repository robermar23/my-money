// @vitest-environment node
import type { InstanceState } from "@/lib/instance/queries.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * P19-10: the page renders in every state its loaders can produce — including
 * the ones where Redis or the database is down — and what it says matches the
 * state. The page's children are synchronous, so the awaited page element
 * renders with `renderToStaticMarkup`.
 */

const loaded = vi.hoisted(() => ({ state: null as unknown }));

vi.mock("@/lib/auth/require-user.ts", () => ({ requireUser: async () => ({ id: "u" }) }));
vi.mock("@/lib/instance/queries.ts", () => ({ loadInstanceState: async () => loaded.state }));
vi.mock("./actions.ts", () => ({ recordRestoreDrillAction: async () => {} }));

const { default: InstanceSettingsPage } = await import("./page.tsx");

const config = {
  backups: { enabled: false, dir: "/backups", retainDays: 14 },
  beancount: { enabled: false },
  email: { smtpSet: false, recipientSet: false },
  plaid: { env: "unset", clientIdSet: false, secretSet: false, webhookUrlSet: false },
  sessionCookieSecure: false,
  autoMigrate: false,
  timeZone: { kind: "unset" },
} as const;

const base: InstanceState = {
  app: config,
  worker: { liveness: { kind: "alive", lastSeen: new Date("2026-10-10T11:59:00Z") }, config },
  backup: { lastSuccessAt: null },
  migrations: { kind: "current", latest: "0027_jazzy_matthew_murdock" },
  drill: { kind: "never" },
  limits: { years: [2024, 2025, 2026], currentYearConfigured: true, firstMissingYear: 2027 },
  version: "0.0.0",
  image: "robermar2/my-money:latest",
  now: new Date("2026-10-10T12:00:00Z"),
};

async function render(state: InstanceState): Promise<string> {
  loaded.state = state;
  return renderToStaticMarkup(await InstanceSettingsPage());
}

describe("/settings/instance", () => {
  it("says plainly that backups are not configured, and how to fix it", async () => {
    const html = await render(base);
    expect(html).toContain("Not configured");
    expect(html).toContain("BACKUP_AGE_RECIPIENT");
    expect(html).toContain("None on record");
    expect(html).toContain("Never recorded");
    expect(html).toContain("Limits for 2027 are not configured");
  });

  it("names the pending migrations and the remedy, without acting", async () => {
    const html = await render({
      ...base,
      migrations: {
        kind: "behind",
        applied: "0025_charming_invaders",
        latest: "0027_jazzy_matthew_murdock",
        pending: ["0026_robust_typhoid_mary", "0027_jazzy_matthew_murdock"],
      },
    });
    expect(html).toContain("The database is at 0025_charming_invaders");
    expect(html).toContain("this image expects 0027_jazzy_matthew_murdock");
    expect(html).toContain("scripts/prod.sh migrate");
    expect(html).toContain("docs/DEPLOY.md");
  });

  it("warns while MONEY_AUTO_MIGRATE is on, and says it is off otherwise (P19-21)", async () => {
    expect(await render(base)).toContain("Migrations run only when you run them");
    const html = await render({ ...base, app: { ...config, autoMigrate: true } });
    expect(html).toContain("On (MONEY_AUTO_MIGRATE)");
    expect(html).toContain("without taking a backup first");
  });

  it("says days are UTC, and that TZ is unset, by default (P19-24/25)", async () => {
    const html = await render(base);
    expect(html).toContain("UTC (TZ is not set)");
    expect(html).toContain("Backup 04:00, Beancount export 04:30 (UTC)");
    expect(html).toContain("Days are UTC dates<");
  });

  it("gives the worker's zone, its offset, and where the UTC day starts in it", async () => {
    const sydney = { ...config, timeZone: { kind: "zone", zone: "Australia/Sydney" } } as const;
    const html = await render({ ...base, worker: { ...base.worker, config: sydney } });
    // 2026-10-10 is daylight time in Sydney (AEDT, UTC+11).
    expect(html).toContain("Australia/Sydney (UTC+11:00 now)");
    expect(html).toContain("Backup 04:00, Beancount export 04:30 (Australia/Sydney)");
    expect(html).toContain("which is 12:30 to 16:00 here");
    expect(html).toContain("a new day starts at 11:00 here");
  });

  it("warns about an invalid TZ and says the jobs run on UTC", async () => {
    const bad = { ...config, timeZone: { kind: "invalid", raw: "Mars/Olympus" } } as const;
    const html = await render({ ...base, worker: { ...base.worker, config: bad } });
    expect(html).toContain("TZ=Mars/Olympus is not a time zone; running on UTC");
    expect(html).toContain("Backup 04:00, Beancount export 04:30 (UTC)");
  });

  it("still renders when Redis and the database are unavailable", async () => {
    const down = { kind: "unavailable" } as const;
    const html = await render({
      ...base,
      worker: down,
      backup: down,
      migrations: down,
      drill: down,
    });
    expect(html).toContain("Could not be read just now");
    expect(html).toContain("Unknown");
  });

  it("shows a stale worker and a due drill as warnings", async () => {
    const html = await render({
      ...base,
      worker: { liveness: { kind: "stale", lastSeen: new Date("2026-10-09T00:00:00Z") }, config },
      drill: { kind: "recorded", at: new Date("2026-06-01T00:00:00Z"), ageDays: 131, due: true },
    });
    expect(html).toContain("Not seen since 2026-10-09 00:00 UTC");
    expect(html).toContain("at least every quarter");
    expect(html).toContain("does not check that the restore worked");
  });

  it("never nests the drill form inside a paragraph", async () => {
    // <form> is not valid inside <p>; the browser would split it and React
    // would report a hydration mismatch.
    expect(await render(base)).not.toMatch(/<p[^>]*>(?:(?!<\/p>).)*<form/s);
  });
});
