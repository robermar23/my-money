import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id parameters.
 *
 * OWASP Password Storage Cheat Sheet (2024) recommends, for argon2id:
 *   m=19456 (19 MiB), t=2, p=1, hashLen=32, saltLen=16.
 *
 * These are deliberately memory-hard to resist GPU brute-force. On a modern
 * CPU each verify takes ~50ms — fine for a single-user login flow.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * Hash a plaintext password with argon2id.
 *
 * @param password - The plaintext password to hash.
 * @returns A self-describing argon2id encoded string (includes algorithm, params, salt, hash).
 */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a plaintext password against a stored argon2id hash.
 *
 * Constant-time within the argon2 implementation; safe against timing attacks.
 *
 * @param storedHash - The encoded argon2id hash from the database.
 * @param password - The plaintext password the user supplied.
 * @returns `true` if the password matches the hash, `false` otherwise.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  return verify(storedHash, password);
}
