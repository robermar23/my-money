import "server-only";

/**
 * Which optional subsystems this process is configured for (PLAN19 P19-09,
 * ADR-052).
 *
 * There is no central env module in this codebase — each subsystem reads its
 * own variables at the point of use. This module does not change that. It is a
 * second, read-only reader that answers one question for `/settings/instance`:
 * "is this switched on?"
 *
 * ── Configuration, never figures (ADR-052 §6) ──────────────────────────────
 * The result holds booleans, enums and non-secret scalars ONLY. A secret's
 * value never enters the returned object, not even truncated or masked: the
 * Plaid client id and secret, `SMTP_URL` (which carries the mail password),
 * `ALERT_EMAIL_TO` (an address is personal data), the `age` recipient,
 * `SESSION_SECRET`, `MONEY_ENCRYPTION_KEY` and `DATABASE_URL` are reduced to
 * "present or not". The test walks the result for substrings of every input.
 *
 * ── A reporter, never a validator (ADR-052 §7) ─────────────────────────────
 * Nothing here throws, and nothing here may ever refuse a boot or fail a
 * render. An unparseable value is reported as its default or as `"other"`, not
 * raised. A working instance with no backups is a *warned* instance.
 *
 * ── Which process sees what ────────────────────────────────────────────────
 * In the shipped compose file the backup, Beancount and email variables are
 * set on the `worker` container only, so the app process cannot see them.
 * The worker therefore runs this same function and returns the result from its
 * heartbeat job (see `src/worker/jobs/heartbeat.ts`), and the page reads that
 * report for the worker-owned subsystems. `CLOUDFLARED_TOKEN` reaches neither
 * process — it lives only in the `cloudflared` container — so the tunnel is
 * reported through its visible consequence, `PLAID_WEBHOOK_URL`, rather than by
 * copying a secret into the app just to say it exists.
 */

/**
 * `PLAID_ENV` as `src/lib/plaid/client.ts` will judge it: `sandbox` and
 * `production` are the only values it accepts (ADR-008 — Plaid retired the
 * Development tier), `unset` and `other` are what it will refuse at first use.
 */
export type PlaidEnvState = "sandbox" | "production" | "unset" | "other";

export interface InstanceConfigState {
  readonly backups: {
    /** `BACKUP_AGE_RECIPIENT` is set — the nightly job runs. */
    readonly enabled: boolean;
    /** Where dumps are written (a container path, not a secret). */
    readonly dir: string;
    readonly retainDays: number;
  };
  readonly beancount: {
    /** `BEANCOUNT_DIR` is set — the nightly plain-text mirror runs. */
    readonly enabled: boolean;
  };
  readonly email: {
    /** `SMTP_URL` is set. Its value carries credentials and is never reported. */
    readonly smtpSet: boolean;
    /** `ALERT_EMAIL_TO` is set. The address itself is never reported. */
    readonly recipientSet: boolean;
  };
  readonly plaid: {
    readonly env: PlaidEnvState;
    readonly clientIdSet: boolean;
    readonly secretSet: boolean;
    /** `PLAID_WEBHOOK_URL` is set — the tunnel's visible consequence. */
    readonly webhookUrlSet: boolean;
  };
  /**
   * `SESSION_COOKIE_SECURE` is exactly `"true"` — the same strict comparison
   * `src/lib/auth/session.ts` makes. The cookie is then only sent over HTTPS.
   */
  readonly sessionCookieSecure: boolean;
}

const DEFAULT_BACKUP_DIR = "/backups";
const DEFAULT_RETAIN_DAYS = 14;

function present(raw: string | undefined): boolean {
  return (raw?.trim() ?? "") !== "";
}

/** Same parse as the backup job, so the page never disagrees with the job. */
function retainDays(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETAIN_DAYS;
}

/** Mirrors the Plaid client's own check exactly, so the page cannot disagree. */
function plaidEnv(raw: string | undefined): PlaidEnvState {
  if (raw === undefined || raw === "") return "unset";
  return raw === "sandbox" || raw === "production" ? raw : "other";
}

/**
 * Report which optional subsystems `env` configures.
 *
 * @param env - The process environment (injectable for tests).
 * @returns Presence and state only; never a secret value. Never throws.
 */
export function instanceConfigState(
  env: Readonly<Record<string, string | undefined>> = process.env,
): InstanceConfigState {
  return {
    backups: {
      enabled: present(env.BACKUP_AGE_RECIPIENT),
      dir: env.BACKUP_DIR?.trim() || DEFAULT_BACKUP_DIR,
      retainDays: retainDays(env.BACKUP_RETAIN_DAYS),
    },
    beancount: { enabled: present(env.BEANCOUNT_DIR) },
    email: { smtpSet: present(env.SMTP_URL), recipientSet: present(env.ALERT_EMAIL_TO) },
    plaid: {
      env: plaidEnv(env.PLAID_ENV),
      // The Plaid client checks length without trimming; match it.
      clientIdSet: (env.PLAID_CLIENT_ID ?? "") !== "",
      secretSet: (env.PLAID_SECRET ?? "") !== "",
      webhookUrlSet: present(env.PLAID_WEBHOOK_URL),
    },
    sessionCookieSecure: env.SESSION_COOKIE_SECURE === "true",
  };
}
