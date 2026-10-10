// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { instanceConfigState } from "./config-state.ts";

/**
 * P19-09 (ADR-052 §6/§7): one verdict per subsystem, and no secret value in the
 * result for any input.
 */

/** Distinctive values, so a leak of any 6-character run is unambiguous. */
const SECRETS = {
  BACKUP_AGE_RECIPIENT: "age1qyqszqgpqyqszqgpqyqszqgpqyqszqgp",
  SMTP_URL: "smtp://mailuser:Hunter2Pw@mail.example.test:587",
  ALERT_EMAIL_TO: "household.person@example.test",
  PLAID_CLIENT_ID: "5f2b9c0e7d1a4b3c8e6f0a1b",
  PLAID_SECRET: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c",
  PLAID_WEBHOOK_URL: "https://hooks.private-domain.test/api/plaid/webhook",
  CLOUDFLARED_TOKEN: "eyJhIjoiZmFrZXR1bm5lbHRva2VuIn0",
  SESSION_SECRET: "sessionsecretQWERTYUIOPASDFGHJKL",
  MONEY_ENCRYPTION_KEY: "encKEYzxcvbnmZXCVBNMlkjhgfdsa0987",
  DATABASE_URL: "postgres://money:DbPassw0rd@postgres:5432/money",
} as const;

const FULL = {
  ...SECRETS,
  BACKUP_DIR: "/backups",
  BACKUP_RETAIN_DAYS: "30",
  BEANCOUNT_DIR: "/exports",
  PLAID_ENV: "production",
  SESSION_COOKIE_SECURE: "true",
  MONEY_AUTO_MIGRATE: "true",
};

/** Every string leaf in `value`, depth-first. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("instanceConfigState", () => {
  it("reports every subsystem unconfigured on an empty environment", () => {
    expect(instanceConfigState({})).toEqual({
      backups: { enabled: false, dir: "/backups", retainDays: 14 },
      beancount: { enabled: false },
      email: { smtpSet: false, recipientSet: false },
      plaid: { env: "unset", clientIdSet: false, secretSet: false, webhookUrlSet: false },
      sessionCookieSecure: false,
      autoMigrate: false,
    });
  });

  it("reports every subsystem configured on a full environment", () => {
    expect(instanceConfigState(FULL)).toEqual({
      backups: { enabled: true, dir: "/backups", retainDays: 30 },
      beancount: { enabled: true },
      email: { smtpSet: true, recipientSet: true },
      plaid: { env: "production", clientIdSet: true, secretSet: true, webhookUrlSet: true },
      sessionCookieSecure: true,
      autoMigrate: true,
    });
  });

  it("treats a whitespace-only value as unset, as the jobs do", () => {
    const state = instanceConfigState({ BACKUP_AGE_RECIPIENT: "  ", BEANCOUNT_DIR: " " });
    expect(state.backups.enabled).toBe(false);
    expect(state.beancount.enabled).toBe(false);
  });

  it("judges PLAID_ENV exactly as the Plaid client does", () => {
    expect(instanceConfigState({ PLAID_ENV: "sandbox" }).plaid.env).toBe("sandbox");
    // Retired tier and wrong case are both refused by the client (ADR-008).
    expect(instanceConfigState({ PLAID_ENV: "development" }).plaid.env).toBe("other");
    expect(instanceConfigState({ PLAID_ENV: "Production" }).plaid.env).toBe("other");
  });

  it("matches the session's strict SESSION_COOKIE_SECURE check", () => {
    expect(instanceConfigState({ SESSION_COOKIE_SECURE: "TRUE" }).sessionCookieSecure).toBe(false);
    expect(instanceConfigState({ SESSION_COOKIE_SECURE: "1" }).sessionCookieSecure).toBe(false);
  });

  it("reports MONEY_AUTO_MIGRATE on under exactly the value the start script acts on", () => {
    // scripts/app-start.sh migrates only when the variable is the literal
    // string "true"; the page must not say "on" for any other spelling.
    const script = readFileSync("scripts/app-start.sh", "utf8");
    expect(script).toContain('if [ "${MONEY_AUTO_MIGRATE:-}" = "true" ]; then');
    expect(instanceConfigState({ MONEY_AUTO_MIGRATE: "true" }).autoMigrate).toBe(true);
    expect(instanceConfigState({ MONEY_AUTO_MIGRATE: "TRUE" }).autoMigrate).toBe(false);
    expect(instanceConfigState({ MONEY_AUTO_MIGRATE: "1" }).autoMigrate).toBe(false);
  });

  it("falls back to the job's retention default instead of throwing", () => {
    expect(instanceConfigState({ BACKUP_RETAIN_DAYS: "soon" }).backups.retainDays).toBe(14);
    expect(instanceConfigState({ BACKUP_RETAIN_DAYS: "-3" }).backups.retainDays).toBe(14);
  });

  it("never returns any part of a secret value", () => {
    const leaves = strings(instanceConfigState(FULL));
    for (const [name, secret] of Object.entries(SECRETS)) {
      for (let i = 0; i + 6 <= secret.length; i += 1) {
        const run = secret.slice(i, i + 6);
        for (const leaf of leaves) {
          expect(leaf.includes(run), `${name} leaked "${run}" into "${leaf}"`).toBe(false);
        }
      }
    }
  });
});
