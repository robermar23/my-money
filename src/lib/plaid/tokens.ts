import "server-only";

import { type Db, db } from "@/db/client.ts";
import { plaidItems } from "@/db/schema/index.ts";
import { decrypt, decryptWithKey, encrypt, encryptWithKey } from "@/lib/crypto/aead.ts";
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
  if (!row.ciphertext) {
    // Disconnected Item — the dead token was wiped by P4-26.
    throw new Error(`loadAccessToken: plaid_items row id=${plaidItemPk} has no stored token`);
  }
  return decrypt(row.ciphertext).toString("utf8");
}

/**
 * Test-helper / audit helper: does this Item have an access token stored?
 *
 * Returns true if the encryption barrier holds a usable ciphertext, false
 * after disconnect (P4-26) wipes it. Useful in tests that want to assert the
 * disconnect post-condition WITHOUT importing the column literal — keeps the
 * "single reader" visibility invariant intact.
 */
export async function isAccessTokenStored(plaidItemPk: string): Promise<boolean> {
  const [row] = await db
    .select({ ciphertext: plaidItems.accessTokenCiphertext })
    .from(plaidItems)
    .where(eq(plaidItems.id, plaidItemPk))
    .limit(1);
  return row?.ciphertext != null;
}

/**
 * P4-26 — wipe the dead access_token_ciphertext after `/item/remove`.
 *
 * Plaid's /item/remove invalidates the access_token on Plaid's side; the
 * ciphertext we hold is dead weight from that moment on. Wiping it removes
 * a small security smell ("why are we still storing a credential to a
 * connection we explicitly tore down?") and makes the disconnect flow's
 * intent legible in the data.
 *
 * Idempotent: calling on a row that already has NULL is a no-op.
 */
export async function clearAccessToken(plaidItemPk: string): Promise<void> {
  await db
    .update(plaidItems)
    .set({ accessTokenCiphertext: null, updatedAt: new Date() })
    .where(eq(plaidItems.id, plaidItemPk));
}

/**
 * P4-37 — Re-encrypt every stored access token from `oldKey` to `newKey`.
 *
 * Walks every row in `plaid_items` whose ciphertext column is non-NULL,
 * decrypts with the *old* key, re-encrypts with the *new* key, and writes the
 * envelope back — all inside a single DB transaction. If any row fails to
 * decrypt (wrong old key, tampered envelope), the entire transaction rolls
 * back; the database stays internally consistent under the *old* key.
 *
 * The runbook in `docs/CRYPTO_ROTATION.md` is the operator-facing wrapper;
 * `scripts/rotate-encryption.ts` is the CLI entry point that resolves the
 * two keys from env and calls this function.
 *
 * Per CLAUDE.md §Plaid Safety Rules: this function NEVER logs the keys or
 * the decrypted token bytes. The result object only carries counts.
 *
 * @returns rowsRotated — the number of plaid_items rows whose ciphertext
 *   was re-encrypted. Tombstones (status='removed' with NULL ciphertext)
 *   are silently skipped and not counted.
 */
export async function rotateEncryption(
  oldKey: Buffer,
  newKey: Buffer,
): Promise<{ rowsRotated: number; rowsSkipped: number }> {
  if (oldKey.length !== 32) {
    throw new Error(`rotateEncryption: oldKey must be 32 bytes (got ${oldKey.length}).`);
  }
  if (newKey.length !== 32) {
    throw new Error(`rotateEncryption: newKey must be 32 bytes (got ${newKey.length}).`);
  }

  let rowsRotated = 0;
  let rowsSkipped = 0;
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: plaidItems.id, ciphertext: plaidItems.accessTokenCiphertext })
      .from(plaidItems);
    for (const row of rows) {
      if (!row.ciphertext) {
        rowsSkipped++;
        continue;
      }
      const plaintext = decryptWithKey(oldKey, row.ciphertext);
      const reencrypted = encryptWithKey(newKey, plaintext);
      await tx
        .update(plaidItems)
        .set({ accessTokenCiphertext: reencrypted, updatedAt: new Date() })
        .where(eq(plaidItems.id, row.id));
      rowsRotated++;
    }
  });
  return { rowsRotated, rowsSkipped };
}
