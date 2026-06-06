/**
 * P4-37 — Encryption-key rotation CLI.
 *
 * Operator-facing wrapper around `rotateEncryption()` in src/lib/plaid/tokens.ts.
 * The full runbook is in docs/CRYPTO_ROTATION.md; this script is the
 * mechanical step the runbook walks you through.
 *
 * Usage:
 *   # Dry run (no DB writes — only reads + validates both keys decrypt).
 *   pnpm plaid:rotate-key -- --dry-run
 *
 *   # Commit the rotation.
 *   pnpm plaid:rotate-key
 *
 * Required env (both keys must be set):
 *   MONEY_ENCRYPTION_KEY      — the current key (decrypts existing rows)
 *   MONEY_ENCRYPTION_KEY_NEW  — the new key (re-encrypts every row)
 *
 * Both keys must be 32 raw bytes, base64-encoded (44 chars). Generate with:
 *   openssl rand -base64 32
 *
 * Per CLAUDE.md §Plaid Safety Rules: this script does not log the keys, the
 * decrypted tokens, or the ciphertext bytes. It prints only counts + status.
 */

import { parseArgs } from "node:util";
import { db } from "../src/db/client.ts";
import { plaidItems } from "../src/db/schema/index.ts";
import { decryptWithKey } from "../src/lib/crypto/aead.ts";
import { rotateEncryption } from "../src/lib/plaid/tokens.ts";

interface CliOptions {
  dryRun: boolean;
}

function parseCli(): CliOptions {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  return { dryRun: values["dry-run"] === true };
}

/** Load + validate a 32-byte base64 key from an env var. */
function loadKeyFromEnv(name: string): Buffer {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      `${name} is not set. Generate one with \`openssl rand -base64 32\` and add it to .env.local.`,
    );
  }
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new Error(`${name} is not valid base64.`);
  }
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error(`${name} decoded to ${key.length} bytes; expected 32.`);
  }
  return key;
}

async function dryRun(oldKey: Buffer): Promise<{ tried: number; ok: number; failed: number }> {
  // Read every ciphertext row and try to decrypt with the OLD key. No writes.
  // This catches a wrong-key scenario before we commit anything.
  const rows = await db
    .select({ id: plaidItems.id, ciphertext: plaidItems.accessTokenCiphertext })
    .from(plaidItems);
  let tried = 0;
  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.ciphertext) continue;
    tried++;
    try {
      decryptWithKey(oldKey, row.ciphertext);
      ok++;
    } catch {
      failed++;
      console.error(`  ✗ row id=${row.id} — old-key decrypt failed`);
    }
  }
  return { tried, ok, failed };
}

async function main(): Promise<void> {
  const { dryRun: isDryRun } = parseCli();

  // Crash early if either key is missing or malformed.
  const oldKey = loadKeyFromEnv("MONEY_ENCRYPTION_KEY");
  const newKey = loadKeyFromEnv("MONEY_ENCRYPTION_KEY_NEW");

  if (oldKey.equals(newKey)) {
    throw new Error(
      "MONEY_ENCRYPTION_KEY_NEW is identical to MONEY_ENCRYPTION_KEY. Generate a fresh key with `openssl rand -base64 32`.",
    );
  }

  console.log("Plaid token rotation");
  console.log(`  mode: ${isDryRun ? "DRY RUN (no writes)" : "LIVE COMMIT"}`);
  console.log("");

  if (isDryRun) {
    const { tried, ok, failed } = await dryRun(oldKey);
    console.log("");
    console.log(`Dry run done. rows=${tried} decryptable=${ok} failed=${failed}.`);
    if (failed > 0) {
      console.error("✗ Some rows failed to decrypt under MONEY_ENCRYPTION_KEY.");
      console.error("  Resolve before running the live rotation — see docs/CRYPTO_ROTATION.md.");
      process.exitCode = 1;
    }
    return;
  }

  // Live commit. rotateEncryption runs the whole walk in one transaction, so
  // a single-row failure rolls back the entire change. The DB ends in a state
  // fully decryptable under EITHER the old key (no change) OR the new key
  // (success) — never half-rotated.
  const result = await rotateEncryption(oldKey, newKey);
  console.log("");
  console.log(`✓ Rotation complete. rotated=${result.rowsRotated} skipped=${result.rowsSkipped}.`);
  console.log("");
  console.log("Next steps (from docs/CRYPTO_ROTATION.md):");
  console.log(
    "  1. Swap .env.local: MONEY_ENCRYPTION_KEY := old value of MONEY_ENCRYPTION_KEY_NEW.",
  );
  console.log("  2. Delete MONEY_ENCRYPTION_KEY_NEW from .env.local.");
  console.log("  3. Restart app + worker containers so they pick up the new key.");
  console.log("  4. Smoke-test: trigger a Force sync on one Item from /settings/connections.");
}

main()
  .catch((err: unknown) => {
    console.error("✗ rotate-encryption failed:");
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void db.$client.end();
  });
