/**
 * P4-30 — One-shot CLI to update each Plaid Item's webhook URL.
 *
 * When the Cloudflare Tunnel (P4-29) goes live, existing Plaid Items still
 * have whatever webhook URL they were created with — often none, since local
 * dev never set `PLAID_WEBHOOK_URL`. This script walks every non-removed
 * `plaid_items` row, calls `/item/webhook/update`, and reports the diff.
 *
 * Usage:
 *   # Read URL from PLAID_WEBHOOK_URL in .env.local.
 *   node --env-file=.env.local --import tsx \
 *     --import ./scripts/loaders/register.mjs \
 *     scripts/plaid-set-webhook-url.ts [--dry-run]
 *
 *   # Override the URL inline.
 *   node --env-file=.env.local --import tsx \
 *     --import ./scripts/loaders/register.mjs \
 *     scripts/plaid-set-webhook-url.ts --url https://money.example.com/api/plaid/webhook
 *
 * Per CLAUDE.md §Plaid Safety Rules: this script does not log the access
 * token. Plaid item_ids ARE logged for diff visibility — they're not secret
 * (they appear in webhook bodies and are useless without the access_token).
 */

import { parseArgs } from "node:util";
import { ne } from "drizzle-orm";
import { db } from "../src/db/client.ts";
import { plaidItems } from "../src/db/schema/index.ts";
import { plaidClient, plaidEnvironment } from "../src/lib/plaid/client.ts";
import { loadAccessToken } from "../src/lib/plaid/tokens.ts";

interface CliOptions {
  url: string;
  dryRun: boolean;
}

function parseCli(): CliOptions {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });

  const url = values.url?.trim() || process.env.PLAID_WEBHOOK_URL?.trim();
  if (!url) {
    throw new Error(
      "No URL specified. Pass --url <https://...> or set PLAID_WEBHOOK_URL in .env.local.",
    );
  }
  // Defense in depth: prevent accidentally pointing Items at localhost/HTTP.
  // Plaid would reject these anyway, but a clear local error is friendlier.
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`Webhook URL must be https:// (got '${parsed.protocol}').`);
  }
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    throw new Error(
      "Webhook URL points at localhost. Plaid cannot reach your loopback — use the Cloudflare Tunnel URL.",
    );
  }
  return { url, dryRun: values["dry-run"] === true };
}

async function main(): Promise<void> {
  const { url, dryRun } = parseCli();
  const env = plaidEnvironment();

  console.log(`Plaid environment: ${env}`);
  console.log(`Target webhook URL: ${url}`);
  if (dryRun) console.log("DRY RUN — no Plaid /item/webhook/update calls will be sent.");
  console.log("");

  // Walk every Item except tombstones — disconnected Items have no token.
  const items = await db
    .select({
      id: plaidItems.id,
      plaidItemId: plaidItems.plaidItemId,
      institutionName: plaidItems.institutionName,
      status: plaidItems.status,
    })
    .from(plaidItems)
    .where(ne(plaidItems.status, "removed"));

  if (items.length === 0) {
    console.log("No active Plaid Items in the database. Nothing to do.");
    return;
  }

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const item of items) {
    const label = `[${item.institutionName} / ${item.plaidItemId}]`;
    try {
      const accessToken = await loadAccessToken(item.id);

      // Fetch the current URL so we can show the diff + skip no-ops.
      const itemGet = await plaidClient.itemGet({ access_token: accessToken });
      const currentUrl = itemGet.data.item.webhook ?? "(none)";

      if (currentUrl === url) {
        console.log(`${label} already at target — skipping.`);
        unchanged++;
        continue;
      }

      console.log(`${label}`);
      console.log(`  from: ${currentUrl}`);
      console.log(`    to: ${url}`);

      if (dryRun) {
        unchanged++; // counts toward "no Plaid call made"
        continue;
      }

      await plaidClient.itemWebhookUpdate({
        access_token: accessToken,
        webhook: url,
      });
      console.log("  ✓ updated");
      updated++;
    } catch (err) {
      // Print a redacted Plaid error if we can extract one; never the token.
      const e = err as {
        message?: string;
        response?: { data?: { error_code?: string; error_message?: string } };
      };
      const code = e.response?.data?.error_code;
      const msg = e.response?.data?.error_message ?? e.message ?? String(err);
      console.error(`${label}  ✗ failed: ${code ? `${code} — ` : ""}${msg}`);
      failed++;
    }
  }

  console.log("");
  console.log(
    `Done. updated=${updated} unchanged=${unchanged} failed=${failed} (${items.length} total).`,
  );
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error("✗ plaid-set-webhook-url failed:");
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    // Close the Postgres pool so the process exits cleanly.
    void db.$client.end();
  });
