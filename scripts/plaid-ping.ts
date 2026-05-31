/**
 * Plaid Sandbox smoke test for P4-08.
 *
 * Verifies that PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV are configured
 * and reachable by issuing a `/sandbox/public_token/create` call against the
 * canonical sandbox institution. Prints the returned public_token's prefix
 * and length so you can sanity-check without leaking the full token to your
 * shell history.
 *
 * Run with:
 *   pnpm exec node --env-file=.env.local --import tsx --import ./scripts/loaders/register.mjs scripts/plaid-ping.ts
 *
 * Or via the convenience npm script if you wire one up later. Refuses to run
 * unless PLAID_ENV='sandbox'.
 */

import { Products } from "plaid";
import { plaidClient, plaidEnvironment } from "../src/lib/plaid/client.ts";

const SANDBOX_INSTITUTION = "ins_109508"; // 'First Platypus Bank' — Plaid's canonical sandbox institution

async function main(): Promise<void> {
  const env = plaidEnvironment();
  if (env !== "sandbox") {
    throw new Error(
      `Refusing to run plaid-ping against PLAID_ENV='${env}'. This script only targets sandbox.`,
    );
  }

  console.log("→ Calling /sandbox/public_token/create against First Platypus Bank…");
  const response = await plaidClient.sandboxPublicTokenCreate({
    institution_id: SANDBOX_INSTITUTION,
    initial_products: [Products.Transactions],
  });

  const publicToken = response.data.public_token;
  if (!publicToken || typeof publicToken !== "string") {
    throw new Error(`Unexpected response shape: ${JSON.stringify(response.data)}`);
  }

  // Don't print the full token — even though it's sandbox, the habit matters.
  const prefix = publicToken.slice(0, "public-sandbox-".length);
  console.log(
    `✓ Sandbox is reachable. public_token prefix='${prefix}', length=${publicToken.length}`,
  );
  console.log(`✓ request_id=${response.data.request_id}`);
}

main().catch((err: unknown) => {
  console.error("✗ Plaid ping failed:");
  console.error(err);
  process.exit(1);
});
