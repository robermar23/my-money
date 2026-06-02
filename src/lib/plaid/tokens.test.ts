// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { db } from "@/db/client.ts";
import { plaidItems } from "@/db/schema/index.ts";
import { CryptoDecryptError, encrypt } from "@/lib/crypto/aead.ts";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createPlaidItem, loadAccessToken, rotateEncryption, storeAccessToken } from "./tokens.ts";

async function clearPlaidItems(): Promise<void> {
  await db.execute(sql`TRUNCATE plaid_items, plaid_sync_runs CASCADE`);
}

async function insertItem(opts: {
  plaidItemId: string;
  accessToken: string;
}): Promise<string> {
  return createPlaidItem({
    plaidItemId: opts.plaidItemId,
    institutionId: "ins_test",
    institutionName: "Test Bank",
    accessToken: opts.accessToken,
    productsConsented: ["transactions"],
  });
}

describe("plaid/tokens — createPlaidItem (encrypt + insert)", () => {
  beforeEach(async () => {
    await clearPlaidItems();
  });

  it("rejects an empty token", async () => {
    await expect(
      createPlaidItem({
        plaidItemId: "x",
        institutionId: "y",
        institutionName: "z",
        accessToken: "",
        productsConsented: ["transactions"],
      }),
    ).rejects.toThrow(/empty token/i);
  });

  it("produces a different on-disk ciphertext each call (fresh nonce)", async () => {
    const a = await insertItem({ plaidItemId: "nonce-a", accessToken: "same-token" });
    const b = await insertItem({ plaidItemId: "nonce-b", accessToken: "same-token" });
    const [rowA] = await db
      .select({ ct: plaidItems.accessTokenCiphertext })
      .from(plaidItems)
      .where(eq(plaidItems.id, a));
    const [rowB] = await db
      .select({ ct: plaidItems.accessTokenCiphertext })
      .from(plaidItems)
      .where(eq(plaidItems.id, b));
    // Both rows just landed with a freshly-encrypted token; column is non-null here.
    expect(rowA?.ct).not.toBeNull();
    expect(rowB?.ct).not.toBeNull();
    expect(rowA?.ct?.equals(rowB?.ct ?? Buffer.alloc(0))).toBe(false);
  });
});

describe("plaid/tokens — DB roundtrip", () => {
  beforeEach(async () => {
    await clearPlaidItems();
  });

  it("stores a ciphertext at INSERT time and loadAccessToken decrypts it", async () => {
    const original = "access-sandbox-12345678-abcd-ef01-2345-6789abcdef01";
    const id = await insertItem({ plaidItemId: "plaid-item-1", accessToken: original });

    const loaded = await loadAccessToken(id);
    expect(loaded).toBe(original);
  });

  it("storeAccessToken updates an existing row in place", async () => {
    const id = await insertItem({ plaidItemId: "plaid-item-2", accessToken: "old-token" });

    await storeAccessToken(id, "new-token");
    expect(await loadAccessToken(id)).toBe("new-token");
  });

  it("storeAccessToken throws when the row does not exist", async () => {
    await expect(
      storeAccessToken("00000000-0000-0000-0000-000000000000", "anything"),
    ).rejects.toThrow(/no plaid_items row/);
  });

  it("loadAccessToken throws when the row does not exist", async () => {
    await expect(loadAccessToken("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      /no plaid_items row/,
    );
  });

  it("the on-disk ciphertext is not the plaintext", async () => {
    const original = "access-sandbox-secret-bytes";
    const id = await insertItem({ plaidItemId: "plaid-item-3", accessToken: original });

    // Direct SELECT confirms the column contains opaque AEAD bytes — no leak.
    const rows = await db
      .select({ ct: plaidItems.accessTokenCiphertext })
      .from(plaidItems)
      .where(eq(plaidItems.id, id));
    const ciphertext = rows[0]?.ct;
    expect(ciphertext).toBeInstanceOf(Buffer);
    if (ciphertext) {
      expect(ciphertext.includes(Buffer.from(original))).toBe(false);
    }
  });

  it("loadAccessToken propagates CryptoDecryptError if the row's ciphertext is corrupted", async () => {
    const id = await insertItem({
      plaidItemId: "plaid-item-corrupt",
      accessToken: "valid-token",
    });
    // Replace the row's ciphertext with garbage that decrypt() will reject.
    const garbage = encrypt(Buffer.from("garbage")); // valid envelope, but different content
    // Flip a byte in the auth tag region so decrypt fails the authentication check.
    const tampered = Buffer.from(garbage);
    const tagStart = tampered.length - 16;
    tampered[tagStart] = (tampered[tagStart] ?? 0) ^ 0xff;
    await db
      .update(plaidItems)
      .set({ accessTokenCiphertext: tampered })
      .where(eq(plaidItems.id, id));

    await expect(loadAccessToken(id)).rejects.toBeInstanceOf(CryptoDecryptError);
  });
});

describe("plaid/tokens — rotateEncryption stub", () => {
  it("throws a clear 'not yet implemented' error pointing at P4-37", async () => {
    await expect(rotateEncryption(Buffer.alloc(32), Buffer.alloc(32))).rejects.toThrow(/P4-37/);
  });
});

/**
 * Visibility regression — the most important test in this file.
 *
 * Per P4-09 + CLAUDE.md §Plaid Safety Rules, the `access_token_ciphertext`
 * column and its Drizzle-camelCase form `accessTokenCiphertext` must appear
 * ONLY in:
 *   - src/lib/plaid/tokens.ts          (this module — the sole reader/writer)
 *   - src/lib/plaid/tokens.test.ts     (this file — tests it)
 *   - src/db/schema/plaid-items.ts     (declares the column)
 *
 * Any other src/ occurrence is a bug: it means some other module is reading
 * or writing ciphertext outside the encryption barrier, which defeats the
 * "single reader" invariant. A grep regression test is cheaper and louder
 * than a custom Biome rule.
 *
 * If you legitimately need to extend the allowlist (e.g. P4-37 adds a
 * rotation script), add the path here AND document why in tokens.ts.
 */
const ALLOWLIST = new Set(
  [
    "src/lib/plaid/tokens.ts", // the sole reader/writer
    "src/lib/plaid/tokens.test.ts", // this file
    "src/db/schema/plaid-items.ts", // declares the column
    "src/lib/crypto/aead.ts", // crypto barrier — references the column in a docstring only
  ].map((p) => p.split("/").join(sep)),
);

const FORBIDDEN_PATTERNS = [/accessTokenCiphertext/, /access_token_ciphertext/];

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, acc);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("plaid/tokens — visibility regression (ciphertext column is single-reader)", () => {
  it("the ciphertext column name appears in src/ only inside the allowlisted files", () => {
    const repoRoot = join(__dirname, "..", "..", "..");
    const srcRoot = join(repoRoot, "src");
    const files = walkTsFiles(srcRoot);

    const violators: { file: string; line: number; text: string }[] = [];
    for (const absolute of files) {
      const rel = relative(repoRoot, absolute);
      if (ALLOWLIST.has(rel)) continue;
      const contents = readFileSync(absolute, "utf8");
      const lines = contents.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (FORBIDDEN_PATTERNS.some((p) => p.test(line))) {
          violators.push({ file: rel, line: idx + 1, text: line.trim() });
        }
      });
    }

    if (violators.length > 0) {
      const msg = violators.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join("\n");
      throw new Error(
        `access_token_ciphertext / accessTokenCiphertext leaked outside the allowlist:\n${msg}\n\nRead tokens via loadAccessToken() instead — see src/lib/plaid/tokens.ts.`,
      );
    }
  });
});
