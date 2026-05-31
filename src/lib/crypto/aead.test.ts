import { randomBytes } from "node:crypto";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CryptoConfigError,
  CryptoDecryptError,
  decrypt,
  decryptWithKey,
  encrypt,
  encryptWithKey,
  loadKey,
} from "./aead.ts";

const KEY_ENV_VAR = "MONEY_ENCRYPTION_KEY";

function makeKey(): Buffer {
  return randomBytes(32);
}

describe("aead — loadKey()", () => {
  // Each test in this block manipulates process.env.MONEY_ENCRYPTION_KEY,
  // so save + restore around each one.
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[KEY_ENV_VAR];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[KEY_ENV_VAR];
    } else {
      process.env[KEY_ENV_VAR] = originalEnv;
    }
  });

  it("returns 32 bytes when env var is a valid base64-encoded 32-byte key", () => {
    const key = makeKey();
    process.env[KEY_ENV_VAR] = key.toString("base64");
    const loaded = loadKey();
    expect(loaded.length).toBe(32);
    expect(loaded.equals(key)).toBe(true);
  });

  it("throws CryptoConfigError when env var is missing", () => {
    delete process.env[KEY_ENV_VAR];
    expect(() => loadKey()).toThrow(CryptoConfigError);
    expect(() => loadKey()).toThrow(/not set/i);
  });

  it("throws CryptoConfigError when env var is an empty string", () => {
    process.env[KEY_ENV_VAR] = "";
    expect(() => loadKey()).toThrow(CryptoConfigError);
  });

  it("throws CryptoConfigError when env var is whitespace only", () => {
    process.env[KEY_ENV_VAR] = "   ";
    expect(() => loadKey()).toThrow(CryptoConfigError);
  });

  it("throws CryptoConfigError when env var is not valid base64", () => {
    process.env[KEY_ENV_VAR] = "not!valid$base64@@@";
    expect(() => loadKey()).toThrow(CryptoConfigError);
    expect(() => loadKey()).toThrow(/base64/i);
  });

  it("throws CryptoConfigError when env var is too short (e.g. 16 bytes)", () => {
    process.env[KEY_ENV_VAR] = randomBytes(16).toString("base64");
    expect(() => loadKey()).toThrow(CryptoConfigError);
    expect(() => loadKey()).toThrow(/16 bytes.*expected 32/i);
  });

  it("throws CryptoConfigError when env var is too long (e.g. 64 bytes)", () => {
    process.env[KEY_ENV_VAR] = randomBytes(64).toString("base64");
    expect(() => loadKey()).toThrow(CryptoConfigError);
    expect(() => loadKey()).toThrow(/64 bytes.*expected 32/i);
  });

  it("rejects a legacy hex-encoded 32-byte key (64 hex chars decode as 48 base64 bytes)", () => {
    // Pre-Phase 4 the convention was hex. A 64-hex-char string is also valid
    // base64 — but decodes to 48 bytes, not 32. This test guards the regression
    // path: the user must regenerate their key as base64.
    process.env[KEY_ENV_VAR] = randomBytes(32).toString("hex");
    expect(() => loadKey()).toThrow(CryptoConfigError);
    expect(() => loadKey()).toThrow(/48 bytes/);
  });
});

describe("aead — encrypt/decrypt roundtrip", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[KEY_ENV_VAR];
    process.env[KEY_ENV_VAR] = makeKey().toString("base64");
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[KEY_ENV_VAR];
    } else {
      process.env[KEY_ENV_VAR] = originalEnv;
    }
  });

  it("roundtrips a typical Plaid-token-sized payload", () => {
    // Plaid access tokens are ~70-char strings like "access-sandbox-...".
    const plaintext = Buffer.from("access-sandbox-12345678-abcd-ef01-2345-6789abcdef01");
    const blob = encrypt(plaintext);
    const back = decrypt(blob);
    expect(back.equals(plaintext)).toBe(true);
  });

  it("roundtrips an empty Buffer", () => {
    const plaintext = Buffer.alloc(0);
    const blob = encrypt(plaintext);
    const back = decrypt(blob);
    expect(back.length).toBe(0);
  });

  it("produces a different envelope on each encrypt (fresh nonce)", () => {
    const plaintext = Buffer.from("the same plaintext");
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a.equals(b)).toBe(false);
    // Both decrypt back to the same thing.
    expect(decrypt(a).equals(plaintext)).toBe(true);
    expect(decrypt(b).equals(plaintext)).toBe(true);
  });

  it("emits the documented envelope layout: 0x01 || nonce(12) || ct || tag(16)", () => {
    const plaintext = Buffer.from("hello");
    const blob = encrypt(plaintext);
    // Version byte first.
    expect(blob[0]).toBe(0x01);
    // Minimum length: 1 (version) + 12 (nonce) + 5 (ct) + 16 (tag) = 34.
    expect(blob.length).toBe(1 + 12 + plaintext.length + 16);
  });
});

describe("aead — tamper detection", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[KEY_ENV_VAR];
    process.env[KEY_ENV_VAR] = makeKey().toString("base64");
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[KEY_ENV_VAR];
    } else {
      process.env[KEY_ENV_VAR] = originalEnv;
    }
  });

  it("rejects a single-byte flip anywhere in the ciphertext body", () => {
    const plaintext = Buffer.from("sensitive value");
    const blob = encrypt(plaintext);
    // Flip a byte in the middle of the ciphertext region (after nonce, before tag).
    const tampered = Buffer.from(blob);
    const ctStart = 1 + 12;
    const ctEnd = blob.length - 16;
    const flipIndex = Math.floor((ctStart + ctEnd) / 2);
    tampered[flipIndex] = (tampered[flipIndex] ?? 0) ^ 0x01;
    expect(() => decrypt(tampered)).toThrow(CryptoDecryptError);
  });

  it("rejects a single-byte flip in the auth tag", () => {
    const plaintext = Buffer.from("sensitive value");
    const blob = encrypt(plaintext);
    const tampered = Buffer.from(blob);
    const tagStart = blob.length - 16;
    tampered[tagStart] = (tampered[tagStart] ?? 0) ^ 0xff;
    expect(() => decrypt(tampered)).toThrow(CryptoDecryptError);
  });

  it("rejects a single-byte flip in the nonce", () => {
    const plaintext = Buffer.from("sensitive value");
    const blob = encrypt(plaintext);
    const tampered = Buffer.from(blob);
    tampered[5] = (tampered[5] ?? 0) ^ 0xff; // somewhere in the nonce region
    expect(() => decrypt(tampered)).toThrow(CryptoDecryptError);
  });

  it("rejects a truncated envelope (shorter than version + nonce + tag)", () => {
    const tooShort = Buffer.alloc(1 + 12 + 16 - 1, 0);
    tooShort[0] = 0x01;
    expect(() => decrypt(tooShort)).toThrow(CryptoDecryptError);
    expect(() => decrypt(tooShort)).toThrow(/too short/i);
  });
});

describe("aead — wrong-key rejection", () => {
  it("decrypt with a different key throws CryptoDecryptError", () => {
    const keyA = makeKey();
    const keyB = makeKey();
    const plaintext = Buffer.from("wrong-key test");
    const blob = encryptWithKey(keyA, plaintext);
    expect(() => decryptWithKey(keyB, blob)).toThrow(CryptoDecryptError);
  });

  it("encryptWithKey rejects a non-32-byte key", () => {
    const badKey = randomBytes(16);
    expect(() => encryptWithKey(badKey, Buffer.from("x"))).toThrow(CryptoConfigError);
  });

  it("decryptWithKey rejects a non-32-byte key", () => {
    const goodKey = makeKey();
    const blob = encryptWithKey(goodKey, Buffer.from("x"));
    const badKey = randomBytes(16);
    expect(() => decryptWithKey(badKey, blob)).toThrow(CryptoConfigError);
  });
});

describe("aead — version-byte mismatch", () => {
  it("rejects a version 0x00 envelope", () => {
    const key = makeKey();
    const blob = encryptWithKey(key, Buffer.from("x"));
    const wrongVersion = Buffer.from(blob);
    wrongVersion[0] = 0x00;
    expect(() => decryptWithKey(key, wrongVersion)).toThrow(CryptoDecryptError);
    expect(() => decryptWithKey(key, wrongVersion)).toThrow(/version/i);
  });

  it("rejects a hypothetical future version 0x02 envelope (not yet supported)", () => {
    const key = makeKey();
    const blob = encryptWithKey(key, Buffer.from("x"));
    const wrongVersion = Buffer.from(blob);
    wrongVersion[0] = 0x02;
    expect(() => decryptWithKey(key, wrongVersion)).toThrow(CryptoDecryptError);
    expect(() => decryptWithKey(key, wrongVersion)).toThrow(/version/i);
  });
});

describe("aead — property: decrypt(encrypt(x)) === x", () => {
  it("roundtrips arbitrary plaintexts of length 0..1024 under a fixed key", () => {
    const key = makeKey();
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 1024 }), (bytes) => {
        const plaintext = Buffer.from(bytes);
        const blob = encryptWithKey(key, plaintext);
        const back = decryptWithKey(key, blob);
        return back.equals(plaintext);
      }),
      { numRuns: 200 },
    );
  });

  it("roundtrips arbitrary plaintexts under freshly-generated keys", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 256 }), (bytes) => {
        const key = makeKey();
        const plaintext = Buffer.from(bytes);
        const blob = encryptWithKey(key, plaintext);
        const back = decryptWithKey(key, blob);
        return back.equals(plaintext);
      }),
      { numRuns: 100 },
    );
  });
});
