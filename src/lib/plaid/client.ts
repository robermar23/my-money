import "server-only";

import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

/**
 * Plaid SDK wrapper.
 *
 * Per CLAUDE.md §Plaid Safety Rules: PLAID_CLIENT_ID and PLAID_SECRET MUST
 * NOT reach the browser. This file is the only module that reads them; any
 * other Plaid SDK call goes through the `plaidClient` export. The `server-only`
 * import at the top makes Next.js error if this file accidentally gets pulled
 * into a client bundle.
 *
 * Per ADR-008: only Sandbox and Production are supported (Plaid retired the
 * Development tier in 2024–2025).
 */

const SUPPORTED_ENVS = ["sandbox", "production"] as const;
type PlaidEnv = (typeof SUPPORTED_ENVS)[number];

function readEnv(): { env: PlaidEnv; clientId: string; secret: string } {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const envRaw = process.env.PLAID_ENV;

  if (!clientId || clientId.length === 0) {
    throw new Error(
      "PLAID_CLIENT_ID is not set. Add it to .env.local (get yours from https://dashboard.plaid.com → Team Settings → Keys).",
    );
  }
  if (!secret || secret.length === 0) {
    throw new Error(
      "PLAID_SECRET is not set. Add it to .env.local (sandbox or production secret per PLAID_ENV).",
    );
  }
  if (!envRaw || !SUPPORTED_ENVS.includes(envRaw as PlaidEnv)) {
    throw new Error(
      `PLAID_ENV must be 'sandbox' or 'production' (got '${envRaw ?? "<unset>"}'). Per ADR-008, Plaid retired the Development tier.`,
    );
  }
  return { env: envRaw as PlaidEnv, clientId, secret };
}

function build(): PlaidApi {
  const { env, clientId, secret } = readEnv();
  const configuration = new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
        // Pin the API version so SDK upgrades don't quietly change response shape.
        "Plaid-Version": "2020-09-14",
      },
    },
  });
  return new PlaidApi(configuration);
}

/**
 * The single Plaid client used everywhere in the app.
 *
 * Lazy-initialized so importing this module without PLAID_* env vars set
 * doesn't crash the boot — Plaid features are opt-in. The first access
 * triggers validation; missing env throws a clear error at that point.
 */
let _instance: PlaidApi | null = null;
function getInstance(): PlaidApi {
  if (_instance === null) {
    _instance = build();
  }
  return _instance;
}

export const plaidClient: PlaidApi = new Proxy({} as PlaidApi, {
  get(_target, prop, receiver) {
    return Reflect.get(getInstance(), prop, receiver);
  },
});

/**
 * Resolved Plaid environment for logging/diagnostics. Read-only.
 *
 * Reading this triggers env validation; treat it as "ensure Plaid is
 * configured" without making an API call.
 */
export function plaidEnvironment(): PlaidEnv {
  return readEnv().env;
}

/**
 * Resolve the configured public webhook URL Plaid should POST to.
 *
 * Centralized here so `PLAID_WEBHOOK_URL` is read only from `src/lib/plaid/`
 * — the P4-36 hardening audit greps for env reads outside this directory.
 * Returns `undefined` when unset (local dev without a tunnel — Plaid Link
 * still works; webhooks just don't deliver).
 */
export function plaidWebhookUrl(): string | undefined {
  const raw = process.env.PLAID_WEBHOOK_URL?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}
