import "server-only";

import { type Db, db } from "@/db/client.ts";
import { plaidItems } from "@/db/schema/index.ts";
import { decrypt, encrypt } from "@/lib/crypto/aead.ts";
import { eq } from "drizzle-orm";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Encrypted Plaid access-token storage.
 *
 * Per CLAUDE.md §Plaid Safety Rules: Plaid access tokens MUST be encrypted at
 * rest with `MONEY_ENCRYPTION_KEY`. This module is the ONLY allowed reader
 * of `plaid_items.access_token_ciphertext`. Anything else that needs the
 * access token calls `loadAccessToken()`; nothing else calls `decrypt()` on
 * a ciphertext from this column.
 *
 * The "single reader" invariant is enforced three ways:
 *   - convention + code review (this comment + the doc on loadAccessToken)
 *   - tokens.test.ts visibility regression — greps `src/` for the column name
 *     and asserts it only appears inside the allowed allowlist files
 *   - P4-36's broader audit pass before Phase 4 ships
 *
 * All public functions take our internal `plaid_items.id` UUID, not Plaid's
 * text `item_id`. Callers that have only Plaid's text id do the lookup first
 * — the indirection means an attacker who learns a text item_id from a
 * webhook log cannot directly read tokens.
 */

/**
 * Encrypt an access token into its on-disk ciphertext envelope.
 *
 * Internal — `createPlaidItem` is the surface callers use to write a token,
 * so callers do not handle the raw envelope directly. Pure function.
 */
function encryptAccessToken(accessToken: string): Buffer {
  if (accessToken.length === 0) {
    throw new Error("encryptAccessToken: refusing to encrypt an empty token");
  }
  return encrypt(Buffer.from(accessToken, "utf8"));
}

/**
 * Insert a new plaid_items row, encrypting the access_token before it ever
 * touches the database driver. This is the ONLY allowed insert path for the
 * row; the column literal is intentionally scoped to this file so the
 * visibility regression in tokens.test.ts can hold a strong invariant.
 *
 * Pass an existing transaction (e.g. the one in `exchangePublicTokenAction`)
 * via `txOrDb` to participate in an atomic outer operation.
 *
 * @returns the newly-inserted row's `id` (our internal UUID, not Plaid's).
 */
export async function createPlaidItem(
  row: {
    plaidItemId: string;
    institutionId: string;
    institutionName: string;
    accessToken: string;
    productsConsented: string[];
  },
  txOrDb: Tx | Db = db,
): Promise<string> {
  const ciphertext = encryptAccessToken(row.accessToken);
  const [inserted] = await txOrDb
    .insert(plaidItems)
    .values({
      plaidItemId: row.plaidItemId,
      institutionId: row.institutionId,
      institutionName: row.institutionName,
      accessTokenCiphertext: ciphertext,
      productsConsented: row.productsConsented,
      status: "active",
    })
    .returning({ id: plaidItems.id });
  if (!inserted) throw new Error("createPlaidItem: insert returned no row");
  return inserted.id;
}

/**
 * Re-encrypt and persist an access token for an existing plaid_items row.
 *
 * Used by the reauth flow (P4-25) when Plaid issues a fresh access_token,
 * and by the rotation runbook (P4-37). For new-row creation, use
 * `encryptAccessToken` and INSERT directly — `storeAccessToken` requires
 * the row to already exist.
 *
 * @throws if no plaid_items row exists with that id.
 */
export async function storeAccessToken(plaidItemPk: string, accessToken: string): Promise<void> {
  const ciphertext = encryptAccessToken(accessToken);
  const updated = await db
    .update(plaidItems)
    .set({ accessTokenCiphertext: ciphertext, updatedAt: new Date() })
    .where(eq(plaidItems.id, plaidItemPk))
    .returning({ id: plaidItems.id });
  if (updated.length === 0) {
    throw new Error(`storeAccessToken: no plaid_items row with id=${plaidItemPk}`);
  }
}

/**
 * Decrypt and return the access token for the given plaid_items row.
 *
 * This is the ONLY function that may SELECT `access_token_ciphertext`. The
 * worker (P4-18), reauth Link-token issuer (P4-25), and disconnect flow
 * (P4-26) all read tokens via this function — never inline.
 *
 * @throws if no plaid_items row exists with that id.
 * @throws CryptoDecryptError if the ciphertext fails authentication (wrong
 *   key, tampered bytes, or version mismatch — see aead.ts).
 */
export async function loadAccessToken(plaidItemPk: string): Promise<string> {
  const rows = await db
    .select({ ciphertext: plaidItems.accessTokenCiphertext })
    .from(plaidItems)
    .where(eq(plaidItems.id, plaidItemPk))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`loadAccessToken: no plaid_items row with id=${plaidItemPk}`);
  }
  return decrypt(row.ciphertext).toString("utf8");
}

/**
 * Re-encrypt every stored access token from `oldKey` to `newKey`.
 *
 * Stub for the P4-37 key-rotation runbook. The full implementation lives in
 * `scripts/rotate-encryption.ts` and runs each row's re-encryption in a
 * single transaction so a half-rotated state cannot exist.
 */
export async function rotateEncryption(
  _oldKey: Buffer,
  _newKey: Buffer,
): Promise<{ rowsRotated: number }> {
  throw new Error(
    "rotateEncryption is a P4-37 stub. Run scripts/rotate-encryption.ts when that script lands.",
  );
}
