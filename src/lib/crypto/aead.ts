import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM authenticated encryption for at-rest secrets.
 *
 * Per ADR-009 (PLAN4.md) this is the cipher behind every Plaid access token
 * stored in `plaid_items.access_token_ciphertext`. It is intentionally
 * dependency-free: only `node:crypto`.
 *
 * On-disk blob layout (self-describing — `decrypt` needs no out-of-band data):
 *
 *   [ version: 1 byte = 0x01 ][ nonce: 12 bytes ][ ciphertext: variable ][ auth tag: 16 bytes ]
 *
 * The version byte exists so a future migration to a different AEAD (e.g.
 * XChaCha20-Poly1305) is an additive `if (version === 0x02) ...` branch
 * instead of a flag day.
 *
 * Per CLAUDE.md §Plaid Safety Rules: nothing in this module logs the key,
 * the plaintext, or the ciphertext. Callers should not log them either.
 */

const VERSION_V1 = 0x01 as const;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const KEY_ENV_VAR = "MONEY_ENCRYPTION_KEY";
const HEADER_LEN = 1 + NONCE_LEN; // version + nonce
const MIN_BLOB_LEN = HEADER_LEN + TAG_LEN;

/** Raised when env configuration is wrong (missing key, wrong length, bad encoding). */
export class CryptoConfigError extends Error {
  override readonly name = "CryptoConfigError";
}

/** Raised when a ciphertext fails authentication or has a malformed envelope. */
export class CryptoDecryptError extends Error {
  override readonly name = "CryptoDecryptError";
}

/**
 * Read `MONEY_ENCRYPTION_KEY` from the environment, base64-decode it, and
 * return the raw 32-byte key.
 *
 * Pure read-from-env; idempotent by construction (no mutation, no cache). The
 * cost of re-decoding 44 base64 chars on every encrypt is negligible at our
 * write rate.
 *
 * @returns A 32-byte Buffer suitable for AES-256-GCM.
 * @throws CryptoConfigError if the env var is missing, not base64, or not 32 bytes.
 */
export function loadKey(): Buffer {
  const raw = process.env[KEY_ENV_VAR];
  if (raw === undefined || raw.trim().length === 0) {
    throw new CryptoConfigError(
      `${KEY_ENV_VAR} is not set. Generate a key with \`openssl rand -base64 32\` and add it to .env.local.`,
    );
  }
  const trimmed = raw.trim();
  // Node's Buffer.from(s, 'base64') is permissive: invalid characters are
  // silently dropped, which would mask a typo. Sanity-check first.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new CryptoConfigError(
      `${KEY_ENV_VAR} is not valid base64. Regenerate with \`openssl rand -base64 32\`.`,
    );
  }
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== KEY_LEN) {
    throw new CryptoConfigError(
      `${KEY_ENV_VAR} decoded to ${key.length} bytes; expected ${KEY_LEN}. Regenerate with \`openssl rand -base64 32\`.`,
    );
  }
  return key;
}

/**
 * Encrypt `plaintext` with the env-configured key.
 *
 * @param plaintext - Bytes to encrypt. Empty Buffer is permitted.
 * @returns A versioned envelope: `0x01 || nonce(12) || ct || tag(16)`.
 * @throws CryptoConfigError if the key env var is missing/invalid.
 */
export function encrypt(plaintext: Buffer): Buffer {
  return encryptWithKey(loadKey(), plaintext);
}

/**
 * Decrypt a versioned AEAD envelope with the env-configured key.
 *
 * @param ciphertext - The envelope produced by `encrypt`.
 * @returns The original plaintext bytes.
 * @throws CryptoConfigError if the key env var is missing/invalid.
 * @throws CryptoDecryptError if the envelope is malformed, the version is
 *   unsupported, or the auth tag fails to verify (tampered ciphertext or
 *   wrong key).
 */
export function decrypt(ciphertext: Buffer): Buffer {
  return decryptWithKey(loadKey(), ciphertext);
}

/**
 * Encrypt with an explicit key. Useful for the rotation runbook (P4-37) and
 * for tests that want to exercise wrong-key rejection.
 */
export function encryptWithKey(key: Buffer, plaintext: Buffer): Buffer {
  if (key.length !== KEY_LEN) {
    throw new CryptoConfigError(`AEAD key must be exactly ${KEY_LEN} bytes; got ${key.length}.`);
  }
  // Fresh 12-byte random nonce per encryption. AES-GCM nonce-reuse with the
  // same key is catastrophic; at our write rate (≤ ~10 tokens per lifecycle)
  // birthday-bound collision probability is < 2⁻⁶⁰. See ADR-009.
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION_V1]), nonce, ct, tag]);
}

/**
 * Decrypt with an explicit key. Useful for the rotation runbook (P4-37) and
 * for tests that want to exercise wrong-key rejection.
 */
export function decryptWithKey(key: Buffer, blob: Buffer): Buffer {
  if (key.length !== KEY_LEN) {
    throw new CryptoConfigError(`AEAD key must be exactly ${KEY_LEN} bytes; got ${key.length}.`);
  }
  if (blob.length < MIN_BLOB_LEN) {
    throw new CryptoDecryptError(
      `ciphertext too short: ${blob.length} bytes (minimum ${MIN_BLOB_LEN}).`,
    );
  }
  const version = blob[0];
  if (version !== VERSION_V1) {
    throw new CryptoDecryptError(
      `unsupported ciphertext version: 0x${(version ?? 0).toString(16).padStart(2, "0")}.`,
    );
  }
  const nonce = blob.subarray(1, HEADER_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(HEADER_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    throw new CryptoDecryptError(
      "AEAD authentication failed (tampered ciphertext, wrong key, or wrong nonce).",
      { cause: err },
    );
  }
}
